; 来源：georgeharker/tree-sitter-zsh 7a593401efb5418ffdedbe3c0e4c61c6d240166d，MIT；本地适配原生查询和 Web 主题。
[
  (string)
  (raw_string)
  (heredoc_body)
  (heredoc_start)
] @string

[
    (command_name) 

]@function


(variable_name) @variable.zsh

[
  "case"
  "do"
  "done"
  "elif"
  "else"
  "esac"
  "export"
  "fi"
  "for"
  "function"
  "if"
  "in"
  "select"
  "then"
  "unset"
  "until"
  "while"
] @keyword

(comment) @comment

(function_definition name: (word) @function)

(file_descriptor) @number

[
  (command_substitution)
  (process_substitution)
  (expansion)
]@embedded

[
  "&&"
  ">"
  ">>"
  "<"
  "|"
] @operator

(
  (command (_) @constant)
  (#match? @constant "^-")
)

; Zsh 特有展开与限定符；不要将整条声明当成一个函数名。
["local" "typeset" "always"] @keyword
(number) @number
[(dollar_variable) (variable_ref) (expansion)] @variable.zsh
(zsh_glob_qualifier) @type
((command_name) @function.zsh.builtin
 (#match? @function.zsh.builtin "^(print|printf|echo|read|cd|pwd|setopt|unsetopt)$"))
