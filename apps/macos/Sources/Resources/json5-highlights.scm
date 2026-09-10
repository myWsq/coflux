; 来源：Joakker/tree-sitter-json5 966aaa2a6c27a206a5fa11ccbc44122d3daa9c5d，MIT许可随App分发。
(string) @string

; 本地主题适配：Web 将无引号键按字符串着色。
(identifier) @string.special.key

(number) @constant.numeric

(null) @constant.builtin

[(true) (false)] @constant.builtin.boolean

(comment) @comment
