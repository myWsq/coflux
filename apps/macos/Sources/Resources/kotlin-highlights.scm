; 基于 tree-sitter-kotlin v1.1.0 节点定义的 coflux 原生查询。
[(line_comment) (block_comment) (shebang)] @comment
[(string_literal) (multiline_string_literal) (character_literal)] @string
(interpolation "$" (identifier)) @constant
[(number_literal) (float_literal)] @number
(user_type (identifier) @type)
(function_declaration name: (identifier) @function)
(call_expression (identifier) @function)
((identifier) @constant.builtin (#match? @constant.builtin "^(true|false|null)$"))
["fun" "val" "var" "class" "interface" "object" "data" "enum" "sealed"
 "return" "if" "else" "when" "for" "while" "do" "in" "is" "as" "as?"
 "try" "catch" "finally" "throw" "import" "package" "typealias"
 "public" "private" "protected" "internal" "override" "open" "abstract"
 "suspend" "inline" "const" "lateinit" "companion" "constructor" "init"
 "this" "super" "by" "get" "set" "where" "out" "vararg"] @keyword
["=" "+" "-" "*" "/" "%" "==" "!=" "===" "!==" "<" ">" "<=" ">="
 "&&" "||" "!" "!!" "?." "?:" "->" ".." "..<"] @operator
