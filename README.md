# 2FA 社区主题

这是 [2FA](https://github.com/wuzf/2fa) 的公共主题收录仓库。主题作者通过 Pull Request 提交完整主题包，维护者审核合并后，用户可以在支持社区目录的 2FA 版本中直接选择主题。

仓库保存主题包本身。作者的个人仓库只作为可选来源说明；作者删库、改名、设为私有或停止维护，不会删除这里已经合并的主题，也不会影响用户已安装的主题。

## 使用主题

在 2FA 中打开 **设置 → 外观与主题 → 主题 → 社区主题**，选择主题，预览并应用。主题功能从 2FA 2.0.0 起提供，更早的版本需要先升级。目录暂时无法读取时，可以下载 `themes/<主题 id>/2fa-theme.zip`，在 **外观与主题** 中导入。

个人主题不必上架。用户仍可通过文件或个人仓库地址导入自己的主题。

想做自己的主题，从模板仓库 [wuzf/2fa-theme-template](https://github.com/wuzf/2fa-theme-template) 开始；格式与接口见主项目的 [自定义主题](https://github.com/wuzf/2fa/blob/main/docs/THEMES.md) 和 [完整前端主题与 SDK](https://github.com/wuzf/2fa/blob/main/docs/THEME_APP_SDK.md)。

## 提交与更新

完整步骤见 [贡献指南](CONTRIBUTING.md)。每个主题只保留一个当前文件：

```text
themes/<manifest.id>/
├── 2fa-theme.zip   完整可安装主题包
├── theme.json      许可证标识和可选作者仓库地址
└── LICENSE         原许可证全文
```

更新时覆盖同一目录中的 ZIP，并重新生成 `catalog.json`。不要增加按版本号命名的目录、历史 ZIP、子模块或 Git LFS 指针。Git 的提交记录用于审查；应用主题目录只展示当前版本。

`catalog.json` 中的名称、作者、描述、版本、包标识、大小和 SHA256 由实际 ZIP 生成。应用从本仓库取包，不访问元数据中的作者仓库地址，也不在服务端运行作者的构建脚本。

## 仓库检查

使用 Node.js 22 或以上版本：

```sh
npm ci --ignore-scripts
npm run catalog
npm run check
npm test
```

投稿 CI 通过 `pull_request_target` 运行目标分支的工作流，校验器和依赖固定取 PR 的目标提交。投稿分支仅作为数据检出；校验器逐文件比较可信目标树，普通主题 PR 只允许修改 `themes/**` 和 `catalog.json`。修改、增删工作流、校验器、测试、依赖清单、文档或其他文件均会失败，链接和候选 `node_modules` 也会被拒绝；不使用投稿分支的 `.gitignore` 决定检查范围。

校验继续检查文件格式、资源清单、哈希、目录身份、许可证和索引一致性。工作流只有 `contents: read` 权限，不读取 secrets、不执行投稿分支的 JavaScript 或安装脚本、不安装作者仓库依赖，也不自动合并 PR。主题功能、视觉效果、第三方素材授权和运行时行为仍由维护者审查。

本仓库工具代码使用 [MIT](LICENSE) 许可。每个主题遵循自己目录和包内的许可证，第三方字体、图片和其他素材保持原有授权。
