/**
 * 推荐插件集（内置精选）
 * 在「插件」面板展示，支持一键安装到 Web Profile。
 * 清单与用户侧已安装的 Web Profile 依赖保持一致。
 */

/** 推荐插件条目 */
export interface RecommendedPlugin {
  /** 安装标识：传给 `dsh plugin --profile web add <installTarget>` */
  installTarget: string
  /** 包名：用于「已安装」判断，匹配 profile package.json dependencies 的 key */
  name: string
  /** 中文简介 */
  description: string
  /** 来源 */
  source: 'npm' | 'github'
  /** 主页链接 */
  url: string
}

export const RECOMMENDED_PLUGINS: RecommendedPlugin[] = [
  {
    installTarget: 'dshmarket',
    name: 'dshmarket',
    description: 'DSH 可视化插件市场：逛社区、搜索、一键安装',
    source: 'npm',
    url: 'https://www.npmjs.com/package/dshmarket'
  },
  {
    installTarget: '@liustack/modsearch',
    name: '@liustack/modsearch',
    description: '免费 web 搜索插件：web 搜索 / X 搜索 / 网页抓取',
    source: 'npm',
    url: 'https://www.npmjs.com/package/@liustack/modsearch'
  },
  {
    installTarget: '@liustack/modlens',
    name: '@liustack/modlens',
    description: '视觉桥接：贴图即可识别/分析图片，text-only 模型也能看图',
    source: 'npm',
    url: 'https://www.npmjs.com/package/@liustack/modlens'
  },
  {
    installTarget: 'dsh-cost-meter',
    name: 'dsh-cost-meter',
    description: '会话费用统计：本会话成本、当日费用、历史记录、多模型计价',
    source: 'npm',
    url: 'https://www.npmjs.com/package/dsh-cost-meter'
  },
  {
    installTarget: 'dsh-better-sidebar',
    name: 'dsh-better-sidebar',
    description: '开放侧边栏底座：文件渲染、终端、侧边对话、Git、子代理',
    source: 'npm',
    url: 'https://github.com/omdsh-dev/DSH-better-sidebar'
  },
  {
    installTarget: '@wenbin_wb/dsh-bridge',
    name: '@wenbin_wb/dsh-bridge',
    description: '手机扫码远程访问：局域网 + 公网隧道 + 多 IM Bot',
    source: 'npm',
    url: 'https://www.npmjs.com/package/@wenbin_wb/dsh-bridge'
  },
  {
    installTarget: 'github:baihejiangnan/dsh-session-context-menu',
    name: '@baihejiangnan/dsh-session-context-menu',
    description: '更好的右键：会话/工作区/对话正文的原生风格上下文菜单',
    source: 'github',
    url: 'https://github.com/baihejiangnan/dsh-session-context-menu'
  },
  {
    // 本地插件：以 link: 绝对路径指向 ~/.dsh/local-plugins 下的源码，安装即默认启用（注册进 dsh.profile.bundles）
    installTarget: 'link:C:/Users/QIU/.dsh/local-plugins/dsh-model-select-style',
    name: 'dsh-model-select-style',
    description: '输入框「模型选择」改版：供应商 + 模型两级联动按钮，选择逻辑复用官方组件',
    source: 'npm',
    url: 'file:///C:/Users/QIU/.dsh/local-plugins/dsh-model-select-style'
  }
]
