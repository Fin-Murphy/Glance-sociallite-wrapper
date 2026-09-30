//
//  Socialite_WrapperTests.swift
//  Socialite-WrapperTests
//
//  Created by Finnian Murphy on 9/30/26.
//

import Foundation
import Testing
@testable import Socialite_Wrapper

@MainActor
struct NavigationPolicyTests {

    @Test(arguments: [
        "https://www.instagram.com/?variant=following",
        "https://www.instagram.com/?variant=favorites",
        "https://www.instagram.com/direct/inbox/",
        "https://www.instagram.com/stories/x/1/",
        "https://www.instagram.com/someuser/",
        "https://www.instagram.com/someuser/tagged/",
        "https://www.instagram.com/p/abc/",
        "https://www.instagram.com/reel/abc/",
        "https://www.instagram.com/reelsfan/",
        "https://www.instagram.com/stories/someuser/reels/",
        "https://www.instagram.com/explore/search/",
        "https://instagram.com/accounts/login/",
        "https://accountscenter.instagram.com/",
        "https://l.instagram.com/?u=https%3A%2F%2Fwww.instagram.com%2Fp%2Fabc%2F",
    ])
    func allowed(_ url: String) {
        #expect(NavigationPolicy.decision(for: URL(string: url)!) == .allow)
    }

    @Test(arguments: [
        ("https://www.instagram.com/", NavigationPolicy.BlockedSection.forYou, "https://www.instagram.com/?variant=following"),
        ("https://www.instagram.com/?variant=foo", .forYou, "https://www.instagram.com/?variant=following"),
        ("https://www.instagram.com/reels/", .reels, "https://www.instagram.com/?variant=following"),
        ("https://www.instagram.com/reels/xyz/", .reels, "https://www.instagram.com/?variant=following"),
        ("https://www.instagram.com/REELS", .reels, "https://www.instagram.com/?variant=following"),
        ("https://www.instagram.com/explore/", .explore, "https://www.instagram.com/explore/search/"),
        ("https://www.instagram.com/explore", .explore, "https://www.instagram.com/explore/search/"),
        ("https://www.instagram.com/explore/tags/cats/", .explore, "https://www.instagram.com/explore/search/"),
        ("https://www.instagram.com/explore/search/keyword/?q=cats", .explore, "https://www.instagram.com/explore/search/"),
        ("https://www.instagram.com/someuser/reels/", .profileReels, "https://www.instagram.com/someuser/"),
        ("https://www.instagram.com/someuser/reels", .profileReels, "https://www.instagram.com/someuser/"),
    ])
    func redirected(_ url: String, section: NavigationPolicy.BlockedSection, target: String) {
        #expect(NavigationPolicy.decision(for: URL(string: url)!) == .redirect(URL(string: target)!, section))
    }

    @Test(arguments: [
        ("https://example.com/", "https://example.com/"),
        ("https://notinstagram.com/", "https://notinstagram.com/"),
        ("https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2Fa&e=x", "https://example.com/a"),
        ("mailto:someone@example.com", "mailto:someone@example.com"),
        ("tel:+15551234567", "tel:+15551234567"),
    ])
    func external(_ url: String, target: String) {
        #expect(NavigationPolicy.decision(for: URL(string: url)!) == .openExternally(URL(string: target)!))
    }

    @Test(arguments: [
        "instagram://camera",
        "https://apps.apple.com/app/instagram/id389801252",
        "https://l.instagram.com/?u=https%3A%2F%2Fapps.apple.com%2Fapp%2Fx",
    ])
    func denied(_ url: String) {
        #expect(NavigationPolicy.decision(for: URL(string: url)!) == .deny)
    }
}

struct AppBundleTests {

    /// Unit tests run inside the host app (TEST_HOST), so Bundle.main is the app bundle.
    @Test func infoPlistHasDisplayNameAndUsageStrings() {
        let info = Bundle.main.infoDictionary ?? [:]
        #expect(info["CFBundleDisplayName"] as? String == "Glance")
        // A missing usage string crashes "Take Photo" in a DM.
        for key in ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSPhotoLibraryUsageDescription"] {
            #expect((info[key] as? String)?.isEmpty == false, "\(key) is missing or empty")
        }
    }
}
