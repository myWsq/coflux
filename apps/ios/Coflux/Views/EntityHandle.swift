import SwiftUI
import UIKit

/// coflux 实体标识（plan 20260914-entity-handles）：`coflux:<kind>:<短 id>`，
/// 短 id 恒取实体 UUID 的前 8 位十六进制小写。标识是给用户复制、粘给 agent 用的
/// 一串"看得出是 coflux 的、看得出是什么东西的"标识——任何接受 id 的接口同样接受它。
///
/// 标识由各客户端本地拼装（protobuf 契约不带 `ref`，plan 已定案），所以这里是 iOS 侧
/// 唯一的生成点：三处长按复制（设备行 / 工作区行 / 终端 tab chip）都走它。
enum EntityHandle {
    /// 与服务端、worker、两个 CLI、桌面端共用的四个 kind token。
    enum Kind: String {
        case device
        case project
        case workspace
        case terminal
    }

    /// 生成永远是小写、永远取前 8 位（短 id 是碰撞预算，不是可随手缩短的常量）。
    /// id 为空时返回 nil：宁可不给这一项菜单，也不发出一个拼不全的标识。
    static func make(_ kind: Kind, id: String) -> String? {
        let short = id.lowercased().prefix(8)
        guard !short.isEmpty else { return nil }
        return "coflux:\(kind.rawValue):\(short)"
    }
}

extension View {
    /// 长按复制该实体的标识。标识不作为常驻界面文本出现（plan 定案），
    /// 只在系统 context menu 里给这一次复制。
    func copyHandleContextMenu(_ kind: EntityHandle.Kind, id: String) -> some View {
        contextMenu {
            if let handle = EntityHandle.make(kind, id: id) {
                Button {
                    UIPasteboard.general.string = handle
                } label: {
                    Label("复制标识", systemImage: "doc.on.doc")
                }
            }
        }
    }
}
