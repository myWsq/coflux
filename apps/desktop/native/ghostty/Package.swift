// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CofluxGhostty",
    platforms: [.macOS("26.0")],
    products: [.library(name: "CofluxGhostty", type: .dynamic, targets: ["CofluxGhostty"])],
    dependencies: [
        .package(url: "https://github.com/Lakr233/libghostty-spm.git",
                 revision: "7e45d27160f9b34aca9ca5c9820e9207482f9f04"),
    ],
    targets: [
        .target(name: "CofluxGhostty", dependencies: [
            .product(name: "GhosttyTerminal", package: "libghostty-spm"),
            .product(name: "GhosttyKit", package: "libghostty-spm"),
        ]),
    ]
)
