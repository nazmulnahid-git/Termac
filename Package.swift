// swift-tools-version: 6.0
// Termorc, the native macOS app. `scripts/build-app.sh` wraps the executable in Termorc.app.
import PackageDescription

let package = Package(
    name: "Termorc",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Termorc", targets: ["Termorc"]),
        .executable(name: "TermorcWidgets", targets: ["TermorcWidgets"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.99.1"),
    ],
    targets: [
        // Model, persistence and the pure helpers: no AppKit, so it's unit-testable.
        .target(
            name: "TermorcCore",
            path: "Sources/TermorcCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "Termorc",
            dependencies: [
                "TermorcCore",
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ],
            path: "Sources/Termorc",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // The desktop widgets (WidgetKit); `scripts/build-app.sh` wraps them in TermorcWidgets.appex.
        .executableTarget(
            name: "TermorcWidgets",
            dependencies: ["TermorcCore"],
            path: "Sources/TermorcWidgets",
            swiftSettings: [.swiftLanguageMode(.v5), .unsafeFlags(["-application-extension"])],
            // Like Xcode: the extension starts in Foundation's NSExtensionMain, which sets up the
            // connection to WidgetKit and then calls our @main. Started at main itself, it quits.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-application_extension", "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain"])]
        ),
        .testTarget(
            name: "TermorcCoreTests",
            dependencies: ["TermorcCore"],
            path: "tests/TermorcCoreTests"
        ),
    ]
)
