// swift-tools-version: 6.0

import PackageDescription

var products: [Product] = [
    .library(name: "CofluxProtocol", targets: ["CofluxProtocol"]),
    .library(name: "CofluxClientCore", targets: ["CofluxClientCore"]),
]

var targets: [Target] = [
    .target(
        name: "CofluxProtocol",
        dependencies: [
            .product(name: "SwiftProtobuf", package: "swift-protobuf"),
        ],
        path: "Sources/CofluxProtocol"
    ),
    .target(
        name: "CofluxClientCore",
        dependencies: ["CofluxProtocol"],
        path: "Sources/CofluxClientCore"
    ),
    .testTarget(
        name: "CofluxProtocolTests",
        dependencies: ["CofluxProtocol"],
        path: "Tests/CofluxProtocolTests"
    ),
    .testTarget(
        name: "CofluxClientCoreTests",
        dependencies: ["CofluxClientCore"],
        path: "Tests/CofluxClientCoreTests"
    ),
]

// Linux CI 执行协议/状态机测试；Security 与 Network 组合层只在 Apple host 暴露，
// 再由 macOS runner 的 iOS xcodebuild 门验证，避免 Linux 假 stub 掩盖真实平台编译问题。
#if os(macOS)
products.append(.library(name: "CofluxApplePlatform", targets: ["CofluxApplePlatform"]))
targets.append(
    .target(
        name: "CofluxApplePlatform",
        dependencies: ["CofluxClientCore"],
        path: "Sources/CofluxApplePlatform"
    )
)
#endif

let package = Package(
    name: "CofluxSwiftClient",
    platforms: [
        .macOS(.v14),
        .iOS("26.0"),
    ],
    products: products,
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.38.1"),
    ],
    targets: targets,
    swiftLanguageModes: [.v6]
)
