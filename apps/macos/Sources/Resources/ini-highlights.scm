; 来源：justinmk/tree-sitter-ini v1.3.0，许可随App分发。
(section_name
  (text) @type) ; consistency with toml

(comment) @comment @spell

[
  "["
  "]"
] @punctuation.bracket

; Web 中等号保留正文色。

(setting
  (setting_name) @keyword)

; (setting_value) @none ; grammar does not support subtypes

; 本地适配：只给带引号的配置值着色，不猜测裸值的数据类型。
((setting_value) @string
 (#match? @string "^[ \t]*[\"']"))
