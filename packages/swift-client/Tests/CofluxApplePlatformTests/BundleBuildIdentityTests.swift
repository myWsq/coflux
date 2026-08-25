import CofluxApplePlatform
import Foundation
import XCTest

final class BundleBuildIdentityTests: XCTestCase {
    func testReleaseIdentityReadsInjectedBundleKeys() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CofluxBuildIdentityTests-\(UUID().uuidString)", isDirectory: true)
        let bundleURL = root.appendingPathComponent("Fixture.bundle", isDirectory: true)
        let contentsURL = bundleURL.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contentsURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let info: [String: Any] = [
            "CFBundleIdentifier": "dev.coflux.BuildIdentityFixture",
            "CFBundlePackageType": "BNDL",
            "CFBundleShortVersionString": "2.4.6",
            "CFBundleVersion": "135",
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: contentsURL.appendingPathComponent("Info.plist"), options: .atomic)
        let bundle = try XCTUnwrap(Bundle(url: bundleURL))

        XCTAssertEqual(try BundleBuildIdentity.release(from: bundle), "2.4.6+135")
    }

    func testReleaseIdentityCombinesTrimmedBundleVersions() throws {
        XCTAssertEqual(
            try BundleBuildIdentity.release(marketingVersion: " 1.2.3 ", buildVersion: " 456\n"),
            "1.2.3+456"
        )
    }

    func testReleaseIdentityRejectsMissingOrDevelopmentValues() {
        XCTAssertThrowsError(
            try BundleBuildIdentity.release(marketingVersion: nil, buildVersion: "1")
        ) { error in
            XCTAssertEqual(error as? BundleBuildIdentityError, .missingMarketingVersion)
        }
        XCTAssertThrowsError(
            try BundleBuildIdentity.release(marketingVersion: "1.0", buildVersion: " \n")
        ) { error in
            XCTAssertEqual(error as? BundleBuildIdentityError, .missingBuildVersion)
        }
        XCTAssertThrowsError(
            try BundleBuildIdentity.release(marketingVersion: "DEV", buildVersion: "1")
        ) { error in
            XCTAssertEqual(error as? BundleBuildIdentityError, .developmentIdentityInRelease)
        }
        XCTAssertThrowsError(
            try BundleBuildIdentity.release(marketingVersion: "1.0", buildVersion: "dev")
        ) { error in
            XCTAssertEqual(error as? BundleBuildIdentityError, .developmentIdentityInRelease)
        }
    }
}
