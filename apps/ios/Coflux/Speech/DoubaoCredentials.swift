import CryptoKit
import Foundation

/// 豆包输入法 ASR 免 key 通道的设备凭据——伪装成豆包安卓输入法客户端的设备指纹
/// （非用户机密，是伪造的设备指纹，删除后下次对讲自动重新注册，无副作用，故存
/// Application Support 下 JSON 文件而非 Keychain，plan 064 决策）。字段/流程/
/// 常量与 koe/koe-asr/src/doubaoime.rs 逐一对照移植。
struct DoubaoCredentials: Codable {
    var deviceID: String
    var installID: String
    var cdid: String
    var openudid: String
    var clientudid: String
    var token: String
    var tokenUpdatedAtMs: UInt64

    enum CodingKeys: String, CodingKey {
        case deviceID = "device_id"
        case installID = "install_id"
        case cdid, openudid, clientudid, token
        case tokenUpdatedAtMs = "token_updated_at_ms"
    }
}

enum DoubaoCredentialError: Error {
    case registerFailed(String)
    case tokenFailed(String)
}

enum DoubaoCredentialStore {
    // 常量以 doubaoime.rs 第 19-29 行为准
    static let aid: UInt32 = 401_734
    static let userAgent = "com.bytedance.android.doubaoime/100102018 (Linux; U; Android 16; en_US; Pixel 7 Pro; Build/BP2A.250605.031.A2; Cronet/TTNetVersion:94cf429a 2025-11-17 QuicVersion:1f89f732 2025-05-08)"
    private static let registerURL = URL(string: "https://log.snssdk.com/service/2/device_register/")!
    private static let settingsURL = URL(string: "https://is.snssdk.com/service/settings/v3/")!
    private static let tokenRefreshIntervalMs: UInt64 = 12 * 60 * 60 * 1000

    private static var credentialFileURL: URL {
        let base = (try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )) ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Speech/doubaoime_credentials.json")
    }

    /// 对应 doubaoime.rs ensure_credentials：有缓存凭据则用，token 12h 过期则刷新，
    /// 刷新失败回退旧 token（仅当旧 token 非空时）
    static func ensureCredentials() async throws -> DoubaoCredentials {
        var creds: DoubaoCredentials
        if let cached = loadCredentials() {
            creds = cached
        } else {
            creds = try await registerDevice()
        }

        guard shouldRefreshToken(creds) else { return creds }

        do {
            let token = try await fetchToken(deviceID: creds.deviceID, cdid: creds.cdid)
            creds.token = token
            creds.tokenUpdatedAtMs = nowMs()
            saveCredentials(creds)
            return creds
        } catch {
            if !creds.token.isEmpty { return creds }
            throw error
        }
    }

    private static func nowMs() -> UInt64 {
        UInt64(Date().timeIntervalSince1970 * 1000)
    }

    private static func shouldRefreshToken(_ creds: DoubaoCredentials) -> Bool {
        if creds.token.isEmpty || creds.tokenUpdatedAtMs == 0 { return true }
        return nowMs() &- creds.tokenUpdatedAtMs >= tokenRefreshIntervalMs
    }

    private static func loadCredentials() -> DoubaoCredentials? {
        guard let data = try? Data(contentsOf: credentialFileURL),
              let creds = try? JSONDecoder().decode(DoubaoCredentials.self, from: data),
              !creds.deviceID.isEmpty
        else { return nil }
        return creds
    }

    private static func saveCredentials(_ creds: DoubaoCredentials) {
        let url = credentialFileURL
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(creds) else { return }
        try? data.write(to: url, options: .atomic)
    }

    // MARK: - 设备注册（对应 doubaoime.rs register_device/build_register_body/build_register_params）

    private static func registerDevice() async throws -> DoubaoCredentials {
        let cdid = UUID().uuidString.lowercased()
        let openudid = randomHex(bytes: 8)
        let clientudid = UUID().uuidString.lowercased()

        let header: [String: Any] = [
            "device_id": 0, "install_id": 0, "aid": aid, "app_name": "oime",
            "version_code": 100_102_018, "version_name": "1.1.2",
            "manifest_version_code": 100_102_018, "update_version_code": 100_102_018,
            "channel": "official", "package": "com.bytedance.android.doubaoime",
            "device_platform": "android", "os": "android", "os_api": "34", "os_version": "16",
            "device_type": "Pixel 7 Pro", "device_brand": "google", "device_model": "Pixel 7 Pro",
            "resolution": "1080*2400", "dpi": "420", "language": "zh", "timezone": 8,
            "access": "wifi", "rom": "UP1A.231005.007", "rom_version": "UP1A.231005.007",
            "region": "CN", "tz_name": "Asia/Shanghai", "tz_offset": 28800,
            "sim_region": "cn", "carrier_region": "cn", "cpu_abi": "arm64-v8a",
            "build_serial": "unknown", "not_request_sender": 0, "sig_hash": "",
            "google_aid": "", "mc": "", "serial_number": "",
            "openudid": openudid, "clientudid": clientudid, "cdid": cdid,
        ]
        let body: [String: Any] = ["magic_tag": "ss_app_log", "header": header, "_gen_time": nowMs()]
        let bodyData = try JSONSerialization.data(withJSONObject: body)

        var components = URLComponents(url: registerURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "device_platform", value: "android"),
            URLQueryItem(name: "os", value: "android"),
            URLQueryItem(name: "ssmix", value: "a"),
            URLQueryItem(name: "_rticket", value: String(nowMs())),
            URLQueryItem(name: "cdid", value: cdid),
            URLQueryItem(name: "channel", value: "official"),
            URLQueryItem(name: "aid", value: String(aid)),
            URLQueryItem(name: "app_name", value: "oime"),
            URLQueryItem(name: "version_code", value: "100102018"),
            URLQueryItem(name: "version_name", value: "1.1.2"),
            URLQueryItem(name: "manifest_version_code", value: "100102018"),
            URLQueryItem(name: "update_version_code", value: "100102018"),
            URLQueryItem(name: "resolution", value: "1080*2400"),
            URLQueryItem(name: "dpi", value: "420"),
            URLQueryItem(name: "device_type", value: "Pixel 7 Pro"),
            URLQueryItem(name: "device_brand", value: "google"),
            URLQueryItem(name: "language", value: "zh"),
            URLQueryItem(name: "os_api", value: "34"),
            URLQueryItem(name: "os_version", value: "16"),
            URLQueryItem(name: "ac", value: "wifi"),
        ]

        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = bodyData

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw DoubaoCredentialError.registerFailed("device register HTTP \(code)")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DoubaoCredentialError.registerFailed("device register: bad JSON")
        }

        let deviceID: String
        if let idNum = json["device_id"] as? NSNumber, idNum.uint64Value != 0 {
            deviceID = idNum.stringValue
        } else if let idStr = json["device_id_str"] as? String, !idStr.isEmpty, idStr != "0" {
            deviceID = idStr
        } else {
            throw DoubaoCredentialError.registerFailed("device register: no device_id")
        }
        let installID = (json["install_id"] as? NSNumber)?.stringValue ?? ""

        return DoubaoCredentials(
            deviceID: deviceID, installID: installID, cdid: cdid,
            openudid: openudid, clientudid: clientudid, token: "", tokenUpdatedAtMs: 0
        )
    }

    // MARK: - Token（对应 doubaoime.rs get_asr_token；12h 过期，settings 接口取 asr_config.app_key）

    private static func fetchToken(deviceID: String, cdid: String) async throws -> String {
        let bodyString = "body=null"
        let stub = Insecure.MD5.hash(data: Data(bodyString.utf8))
            .map { String(format: "%02X", $0) }.joined()

        var components = URLComponents(url: settingsURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "device_platform", value: "android"),
            URLQueryItem(name: "os", value: "android"),
            URLQueryItem(name: "ssmix", value: "a"),
            URLQueryItem(name: "channel", value: "official"),
            URLQueryItem(name: "aid", value: String(aid)),
            URLQueryItem(name: "app_name", value: "oime"),
            URLQueryItem(name: "version_code", value: "100102018"),
            URLQueryItem(name: "version_name", value: "1.1.2"),
            URLQueryItem(name: "device_id", value: deviceID),
            URLQueryItem(name: "cdid", value: cdid),
            URLQueryItem(name: "_rticket", value: String(nowMs())),
        ]

        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue(stub, forHTTPHeaderField: "x-ss-stub")
        request.httpBody = Data(bodyString.utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw DoubaoCredentialError.tokenFailed("settings HTTP \(code)")
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let dataDict = json["data"] as? [String: Any],
              let settings = dataDict["settings"] as? [String: Any],
              let asrConfig = settings["asr_config"] as? [String: Any],
              let appKey = asrConfig["app_key"] as? String
        else {
            throw DoubaoCredentialError.tokenFailed("settings: no asr_config.app_key")
        }
        return appKey
    }

    private static func randomHex(bytes: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        var result = ""
        for _ in 0..<bytes {
            result += String(format: "%02x", UInt8.random(in: 0...255, using: &generator))
        }
        return result
    }
}
