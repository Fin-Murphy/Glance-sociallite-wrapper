//
//  WebViewModel.swift
//  Socialite-Wrapper
//

import Observation
import UIKit
import WebKit

/// All allow/block rules live here. Edit these to tweak what the app lets through.
/// PageScript's JS guard is generated from the same constants.
enum NavigationPolicy {
    /// Start page, and where blocked Reels and the For you feed go: the Following feed (no stories tray).
    static let home = URL(string: "https://www.instagram.com/?variant=following")!
    static let search = URL(string: "https://www.instagram.com/explore/search/")!

    /// "Open the app" buttons: never followed.
    static let deniedHosts = ["apps.apple.com", "itunes.apple.com", "play.google.com"]

    /// Blocked path prefixes (lowercased, trailing "/") and where each one sends you instead.
    static let blockedPrefixes: [(prefix: String, redirect: URL, section: BlockedSection)] = [
        ("/reels/", home, .reels),        // Reels tab and swipe viewer. Single /reel/<id>/ stays allowed.
        ("/explore/", search, .explore),  // Explore grid, tags, locations, people, keyword results
    ]

    /// Exact paths allowed even though a blocked prefix matches.
    static let allowedExactPaths = ["/explore/search/"]

    /// Profile tabs (/<user>/<tab>/) that are blocked and sent back to the profile.
    static let blockedProfileTabs = ["reels"]

    /// The For you feed: "/" on these hosts is sent to `home` unless its `variant` query item is allowed.
    static let feedHosts = ["instagram.com", "www.instagram.com"]
    static let allowedFeedVariants = ["following", "favorites"]

    enum BlockedSection { case reels, profileReels, explore, forYou }

    enum Decision: Equatable {
        case allow
        case redirect(URL, BlockedSection)  // blocked section: show this page instead
        case openExternally(URL)            // hand to Safari (only when the user tapped)
        case deny                           // ignore: other schemes (instagram://), app-store buttons
    }

    static func decision(for url: URL) -> Decision {
        guard let scheme = url.scheme?.lowercased() else { return .deny }
        if ["about", "blob", "data"].contains(scheme) { return .allow }
        if scheme == "mailto" || scheme == "tel" { return .openExternally(url) }
        guard scheme == "http" || scheme == "https", let host = url.host()?.lowercased() else { return .deny }

        // Outbound links are wrapped as https://l.instagram.com/?u=<real link>.
        if host == "l.instagram.com" {
            let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "u" }?.value.flatMap(URL.init(string:))
            guard let target else { return .deny }
            return decision(for: target)
        }
        guard host == "instagram.com" || host.hasSuffix(".instagram.com") else {
            return deniedHosts.contains(host) ? .deny : .openExternally(url)
        }

        var path = url.path().lowercased()
        if !path.hasSuffix("/") { path += "/" }
        if path == "/", feedHosts.contains(host) {
            let variant = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "variant" }?.value
            return allowedFeedVariants.contains(variant ?? "") ? .allow : .redirect(home, .forYou)
        }
        if allowedExactPaths.contains(path) { return .allow }
        if let rule = blockedPrefixes.first(where: { path.hasPrefix($0.prefix) }) {
            return .redirect(rule.redirect, rule.section)
        }
        let parts = path.split(separator: "/")
        if parts.count == 2, blockedProfileTabs.contains(String(parts[1])) {
            return .redirect(URL(string: "/\(parts[0])/", relativeTo: home)!.absoluteURL, .profileReels)
        }
        return .allow
    }
}

@Observable
final class WebViewModel: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    /// Set when a blocked section is hit so the UI can show a toast; the view clears it.
    var blockedSection: NavigationPolicy.BlockedSection?
    private(set) var hasLoaded = false
    private(set) var loadFailed = false

    let webView: WKWebView
    @ObservationIgnored private var urlObservation: NSKeyValueObservation?
    @ObservationIgnored private var recentBounces: [Date] = []

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persistent cookies, so login survives relaunches
        config.allowsInlineMediaPlayback = true
        // Mobile Safari's suffix, so Instagram doesn't treat us as an in-app browser.
        let os = ProcessInfo.processInfo.operatingSystemVersion
        config.applicationNameForUserAgent = "Version/\(os.majorVersion).\(os.minorVersion) Mobile/15E148 Safari/604.1"
        config.userContentController.addUserScript(
            WKUserScript(source: PageScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false // long-press previews would show blocked pages
        #if DEBUG
        webView.isInspectable = true // Mac Safari > Develop > <device> > Glance
        #endif
        // Non-opaque with system background avoids a white flash in dark mode.
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.underPageBackgroundColor = .systemBackground
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        // Retains self; fine, the model lives as long as the app.
        webView.configuration.userContentController.add(self, name: PageScript.messageName)

        // Fallback for URL changes the JS guard doesn't see (back/forward, popstate, anything else).
        urlObservation = webView.observe(\.url, options: .new) { [weak self] webView, _ in
            MainActor.assumeIsolated {
                if let url = webView.url, case let .redirect(target, section) = NavigationPolicy.decision(for: url) {
                    self?.redirect(to: target, showing: section, limited: true)
                }
            }
        }

        webView.load(URLRequest(url: NavigationPolicy.home))
    }

    func retry() {
        if webView.url == nil {
            webView.load(URLRequest(url: NavigationPolicy.home))
        } else {
            webView.reload()
        }
    }

    /// Call when the scene becomes active: don't resume on a blocked page.
    func appBecameActive() {
        if let url = webView.url, case let .redirect(target, section) = NavigationPolicy.decision(for: url) {
            redirect(to: target, showing: section, limited: true)
        }
    }

    /// `limited` redirects (not started by a tap) run at most 3 times per 20 s, so a redirect loop can't reload forever.
    private func redirect(to url: URL, showing section: NavigationPolicy.BlockedSection, limited: Bool) {
        if limited {
            let now = Date()
            recentBounces = recentBounces.filter { now.timeIntervalSince($0) < 20 } + [now]
            guard recentBounces.count <= 3 else { return }
        }
        blockedSection = section
        webView.load(URLRequest(url: url))
    }

    // MARK: WKScriptMessageHandler

    /// Reports from PageScript's route guard: a swallowed tap, or a refused pushState/replaceState.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String,
              let url = (body["url"] as? String).flatMap(URL.init(string:)),
              case let .redirect(target, section) = NavigationPolicy.decision(for: url) else { return }
        redirect(to: target, showing: section, limited: type != "click")
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        // Let iframes and subresources load; only police top-level navigations.
        guard navigationAction.targetFrame?.isMainFrame ?? true,
              let url = navigationAction.request.url else { return .allow }
        let userTapped = navigationAction.navigationType == .linkActivated
        let newWindow = navigationAction.targetFrame == nil

        switch NavigationPolicy.decision(for: url) {
        case .allow:
            // Load taps ourselves: allowing them lets iOS hand instagram.com links to the Instagram app
            // (universal links). New windows are handled in createWebViewWith.
            guard userTapped && !newWindow else { return .allow }
            webView.load(navigationAction.request)
            return .cancel
        case let .redirect(target, section):
            redirect(to: target, showing: section, limited: !userTapped)
            return .cancel
        case let .openExternally(external):
            if userTapped || newWindow { await UIApplication.shared.open(external) }
            return .cancel
        case .deny:
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loadFailed = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasLoaded = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    private func handleLoadError(_ error: Error) {
        // Cancellations come from our own blocking and Instagram's SPA navigation, not connectivity.
        let error = error as NSError
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        if error.domain == "WebKitErrorDomain" && error.code == 102 { return } // frame load interrupted by policy change
        loadFailed = true
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: NavigationPolicy.home)) // otherwise a blank white screen
    }

    // MARK: WKUIDelegate

    /// target="_blank" / window.open: there's only one view, so allowed pages open in it.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        switch NavigationPolicy.decision(for: url) {
        case .allow: if url.scheme?.hasPrefix("http") == true { webView.load(navigationAction.request) }
        case let .redirect(target, section): redirect(to: target, showing: section, limited: false)
        case let .openExternally(external): UIApplication.shared.open(external)
        case .deny: break
        }
        return nil
    }

    // WKWebView silently drops JS alert()/confirm() unless these are implemented; Instagram uses confirm().
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        _ = await showDialog(message, cancellable: false)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await showDialog(message, cancellable: true)
    }

    private func showDialog(_ message: String, cancellable: Bool) async -> Bool {
        guard var presenter = webView.window?.rootViewController else { return false }
        while let presented = presenter.presentedViewController { presenter = presented }
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            if cancellable {
                alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: false) })
            }
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume(returning: true) })
            presenter.present(alert, animated: true)
        }
    }
}
