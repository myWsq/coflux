// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "CofluxSwiftClient",
    platforms: [
        .macOS(.v14),
        .iOS("26.0"),
    ],
    products: [
        .library(name: "CofluxProtocol", targets: ["CofluxProtocol"]),
        .library(name: "CofluxClientCore", targets: ["CofluxClientCore"]),
        .library(name: "CofluxApplePlatform", targets: ["CofluxApplePlatform"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.38.1"),
    ],
    targets: [
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
        .target(
            name: "CofluxApplePlatform",
            dependencies: ["CofluxClientCore"],
            path: "Sources/CofluxApplePlatform"
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
        .testTarget(
            name: "CofluxApplePlatformTests",
            dependencies: ["CofluxApplePlatform", "CofluxClientCore"],
            path: "Tests/CofluxApplePlatformTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
