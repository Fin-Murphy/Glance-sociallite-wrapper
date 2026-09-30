//
//  ContentView.swift
//  Socialite-Wrapper
//
//  Created by Finnian Murphy on 9/30/26.
//

import SwiftUI
import WebKit

struct ContentView: View {
    @State private var model = WebViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            WebView(webView: model.webView)

            if !model.hasLoaded && !model.loadFailed {
                ProgressView()
                    .tint(.accentColor)
                    .transition(.opacity)
            }

            if model.loadFailed {
                ContentUnavailableView {
                    Label("Can't reach Instagram", systemImage: "wifi.slash")
                } description: {
                    Text("Check your connection and try again.")
                } actions: {
                    Button("Try Again") { model.retry() }
                        .buttonStyle(.borderedProminent)
                }
                .background(Color(.systemBackground))
            }
        }
        .overlay(alignment: .top) {
            if let section = model.blockedSection {
                HStack(spacing: 8) {
                    Image(systemName: "leaf").foregroundStyle(.tint)
                    Text(toastMessage(for: section))
                        .font(.footnote.weight(.medium))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(.top, 8)
                .allowsHitTesting(false)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.25), value: model.hasLoaded)
        .animation(.default, value: model.blockedSection)
        .task(id: model.blockedSection) {
            guard model.blockedSection != nil, (try? await Task.sleep(for: .seconds(2))) != nil else { return }
            model.blockedSection = nil
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.appBecameActive() }
        }
    }

    private func toastMessage(for section: NavigationPolicy.BlockedSection) -> LocalizedStringKey {
        switch section {
        case .reels: "Reels are switched off. Back to your feed."
        case .profileReels: "Reels are switched off."
        case .explore: "Explore is switched off. Search is still here."
        }
    }
}

/// Hosts the model's WKWebView in SwiftUI.
struct WebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

#Preview {
    ContentView()
}
