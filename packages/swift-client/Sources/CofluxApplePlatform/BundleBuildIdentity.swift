import Foundation

public enum BundleBuildIdentityError: Error, Equatable, Sendable {
    case missingMarketingVersion
    case missingBuildVersion
    case developmentIdentityInRelease
}

/// Release 的控制面版本身份。Debug 的 `dev` 由 App composition 显式选择，不在这里隐式回退。
public enum BundleBuildIdentity {
    public static func release(from bundle: Bundle = .main) throws -> String {
        try release(
            marketingVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            buildVersion: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        )
    }

    public static func release(
        marketingVersion: String?,
        buildVersion: String?
    ) throws -> String {
        guard let marketingVersion = normalized(marketingVersion), !marketingVersion.isEmpty else {
            throw BundleBuildIdentityError.missingMarketingVersion
        }
        guard let buildVersion = normalized(buildVersion), !buildVersion.isEmpty else {
            throw BundleBuildIdentityError.missingBuildVersion
        }
        guard marketingVersion.lowercased() != "dev", buildVersion.lowercased() != "dev" else {
            throw BundleBuildIdentityError.developmentIdentityInRelease
        }
        return "\(marketingVersion)+\(buildVersion)"
    }

    private static func normalized(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
