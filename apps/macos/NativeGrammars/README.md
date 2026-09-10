# 原生语法封装

用于上游 Swift 包不可用，或需要隔离上游额外依赖的 Tree-sitter 语法；其他语法使用工程中的锁定远端依赖。

Erlang 源码来自 manifest.json 中的固定提交，原样保留。上游 0.20 的 Package.swift 在第二行声明 swift-tools-version:5.3，当前 SwiftPM 拒绝解析，且 sources 漏列外部 scanner；这里用独立 C target 同时编译 parser.c 和 scanner.c，不修改下载缓存，也不引入 JS 运行时。

- manifest.json 记录每个上游文件路径、提交与 SHA-256。
- 高亮查询位于 ../Sources/Resources/erlang-highlights.scm，保留上游版权头。
- ../scripts/sync-notices.py 在生成和检查许可证时验证源码哈希，并把原始 LICENSE 加入 App 的 ThirdPartyNotices。
- 升级时统一更新源码、manifest、查询及语义测试；仅修改依赖名称或扩展名登记不构成语言支持。

Less 固定 mdovale/tree-sitter-less 的提交 02988c765d30adb0476657b5d220e8dfde1c07d3（ABI 14、MIT），原样编译 parser/scanner。其 Swift 包为测试声明另一来源的 SwiftTreeSitter 依赖；本地 C target 复用应用现有解析运行时，避免引入第二套解析器依赖。源码和许可哈希纳入 manifest；less-highlights.scm 保留上游查询并追加 Web 暗色主题的 Less 颜色映射。

Vue 固定 tree-sitter-grammars/tree-sitter-vue 的 ABI 14 提交 22bdfa6c9fc0f5ffa44c6e938ec46869ac8a99ff；最新 ABI 15 版本不能直接用于当前运行时。Svelte 固定 tree-sitter-grammars/tree-sitter-svelte 的 ae5199db47757f785e43a14b332118a5474de1a2（ABI 14）。两者在本地 C target 原样编译 parser/scanner/tag.h，统一复用当前解析器；Vue 无 Swift 包，Svelte 包的测试依赖无需另行引入。各自的 MIT 许可和源码哈希均纳入 manifest，高亮查询保留上游来源。模板中的脚本、样式和表达式由宿主语法节点定位，再调用已有原生语言解析器，不执行组件代码。

GraphQL 上游没有 Swift 包，使用同一清单机制固定 C parser 与所需头文件；include/graphql.h 是本仓库写的最小 C 函数声明。原始 MIT LICENSE 随 App 分发。GraphQL 高亮查询位于 ../Sources/Resources/graphql-highlights.scm，按当前 Web 主题调整 capture 分类，不改语法解析器。

JSON5 固定在 ABI 14 的提交 966aaa2a6c27a206a5fa11ccbc44122d3daa9c5d。较新的 v0.1.0/主分支生成 ABI 15，与当前共用运行时不兼容；兼容提交没有 Swift 包，因此使用本地 C target。include/json5.h 是本仓库的最小函数声明，原始 MIT LICENSE 和源码哈希按清单校验。升级时应重新审查语法差异与运行时 ABI，不能只修改 LANGUAGE_VERSION 常量。

Protobuf 固定 treywood/tree-sitter-proto 的 ABI 14 提交，使用原始 C parser 和本仓库最小函数声明 include/proto.h。没有上游 Swift 包，因此同样通过本地 target 接入；MIT LICENSE 与源码哈希纳入统一清单。语法升级需要补充 proto2/proto3/editions 方言的验收，不能从 .proto 分派推断所有方言已支持。

Dart 固定 UserNobody14/tree-sitter-dart 的 ABI 14 提交 c8e7cbbd1589cc2ee1f9b5befa604dc7e953b0af，原样使用 C parser/scanner 与 Swift 公开头。该提交虽提供 Swift 包，但仓库递归子模块要求通过 SSH 下载另一份 Tree-sitter，Swift target 不使用它；本地封装排除这条无关依赖与认证路径。当前上游最新 parser 为 ABI 15，未直接加载或改常量伪造兼容。MIT LICENSE 与原始源码哈希纳入清单，查询位于 ../Sources/Resources/dart-highlights.scm。版本选择未包含后续 Dart 3.10 dot shorthand 等修复，升级时需联动运行时和语法测试。


PowerShell 固定 airbus-cert/tree-sitter-powershell 提交 17f0c1a6514d3b46e64df7b88f464c0bd85078a6（ABI 14）。上游 Swift manifest 漏列 scanner.c，本地 target 同时编译 parser/scanner；不会修改下载缓存。查询按 Web 主题区分函数声明、命令名称、类型与插值变量。

Perl 固定 tree-sitter-perl/tree-sitter-perl 2.0.0 提交 50904961d6a87c5191e611276aa2ecb9d66ca4ff。上游 Git 不包含 parser.c，发布包生成的是 ABI 15；这里用官方 tree-sitter-cli 0.26.6 对该提交的 src/grammar.json 执行 `tree-sitter generate --abi 14 src/grammar.json`，生成真正兼容的 C parser 和头文件。manifest.generation 记录命令、输入哈希、工具地址与下载包哈希；生成文件在 files 中明确标记，scanner 及辅助头原样保留。运行时不需要生成器或 JS，也不执行 Perl。重生成时核对固定提交的输入、工具版本和所有产物哈希；不要手改 LANGUAGE_VERSION 常量。上游 Neovim 查询的 lua-match? 替换为当前解析器支持的 match?（该规则仅匹配相同 shebang 前缀），其余本地改动为颜色分类。

Perl 内部 bsearch.h 带独立 BSD 许可：BSEARCH-LICENSE 保留首段许可原文，manifest 记录提取方式与哈希，sync-notices.py 将 additionalLicenses 一并纳入二进制分发说明。


Groovy 固定 murtaza64/tree-sitter-groovy 提交 deb0dcf8c4544f07564060f6e9b9f6e4b0bfc27d，Zsh 固定 georgeharker/tree-sitter-zsh 提交 7a593401efb5418ffdedbe3c0e4c61c6d240166d。两者从各自提交的 src/grammar.json 用官方 tree-sitter-cli 0.26.6 生成 ABI 14（--output generated），不改原始语法或 ABI 常量，工具与输入/输出哈希见 manifest。Groovy 仅编译 parser，Zsh 另编译原始 scanner。Zsh 使用包含专属参数展开、数组和 glob 限定符的独立语法，不映射到 Bash。两者 MIT 原文随 App 分发。Groovy 查询中依赖编辑器局部变量服务的 is? 规则已移除，参数通过实际节点捕获；本地仅调整高亮查询和主题类别。

Groovy 当前固定语法将 `def values = items.collect { ... }` 的声明与尾随闭包拆成相邻节点；本地查询仅在声明的 dotted_identifier 后紧接 closure 时为末段调用名着色，不把所有属性访问当成方法。Zsh 引号内简单变量使用 variable_ref，完整参数展开使用 expansion，两者都保留独立节点语义。
