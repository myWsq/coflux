import Foundation

enum RemotePath {
    struct Crumb { let name: String; let path: String }
    static func breadcrumbs(_ path: String) -> [Crumb] {
        guard path.hasPrefix("/") else { return [] }
        var result = [Crumb(name: "/", path: "/")]
        var current = ""
        for component in path.split(separator: "/") {
            current += "/" + component
            result.append(Crumb(name: String(component), path: current))
        }
        return result
    }
    static func parent(_ path: String) -> String? {
        let components = breadcrumbs(path)
        guard components.count > 1 else { return nil }
        return components[components.count - 2].path
    }
}
