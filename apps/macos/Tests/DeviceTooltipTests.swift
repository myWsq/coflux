import AppKit
import CofluxClientCore
import CofluxProtocol
import SwiftUI
import XCTest
@testable import Coflux

@MainActor final class DeviceTooltipTests: XCTestCase {
    private var daemon: Coflux_V1_DaemonInfo {
        var value = Coflux_V1_DaemonInfo(); value.online = true; value.host = "mac.local"; value.platform = "macos"
        value.workerVersion = "1.2.3"; value.supervisorVersion = "1.0.0"
        return value
    }
    func testRouteStatusVersionsAndLatencyAreIndependent() {
        for (mode, title, symbol) in [("direct", "本机直连", "zap"), ("p2p", "P2P 直连", "radio"), ("relay", "中心 relay", "cloud")] {
            let value = DeviceRoutePresentation(daemon: daemon, transport: .init(relayHost: nil, rttMs: 199.6, mode: mode, detail: "实际路由详情"))
            XCTAssertEqual(value.title, title + " · 200ms")
            XCTAssertEqual(value.symbol, symbol)
            XCTAssertEqual(value.tone, .success, "颜色按原始RTT判断，标题才取整")
            XCTAssertEqual(value.rows.map(\.text), ["mac.local / macos", "worker 1.2.3", "supervisor 1.0.0", "实际路由详情"])
        }
        let offline = DeviceRoutePresentation(daemon: daemon, transport: .init(relayHost: nil, rttMs: nil, mode: "offline", detail: "授权过期"))
        XCTAssertEqual(offline.title, "Device route 离线", "中心在线不等于设备路由可用")
        XCTAssertEqual(offline.tone, .destructive)
        XCTAssertTrue(offline.accessibilityDetails.contains("授权过期"))
        XCTAssertEqual(DeviceRoutePresentation(daemon: daemon, transport: .init(relayHost: nil, rttMs: nil, mode: "probing")).tone, .primary)
        var missing = daemon; missing.online = false; missing.workerVersion = ""; missing.supervisorVersion = ""
        let value = DeviceRoutePresentation(daemon: missing, transport: nil)
        XCTAssertEqual(value.title, "中心离线"); XCTAssertEqual(value.tone, .hollow)
        XCTAssertEqual(value.rows.count, 1)
    }
    func testDeviceTooltipRendersAllVersionAndRouteRows() throws {
        let value = DeviceRoutePresentation(daemon: daemon, transport: .init(relayHost: "relay.test", rttMs: 42, mode: "relay", detail: "Device 数据经中心 opaque relay（relay.test）"))
        let (host, size) = NativeTooltipAnchor.measuredHost(AnyView(DeviceTooltipContent(presentation: value)))
        XCTAssertLessThanOrEqual(size.width, 300); XCTAssertGreaterThan(size.height, 65)
        for name in ["package", "cog", "info"] { XCTAssertNotNil(NSImage(named: name)) }
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: "/tmp/coflux-device-tooltip.png"))
    }
}
