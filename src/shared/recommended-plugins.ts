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
  /** 内置默认启用：首次运行（服务就绪时）自动安装并注册进 bundles，新装即自带 */
  defaultEnabled?: boolean
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
    installTarget: 'dsh-vision-router',
    name: 'dsh-vision-router',
    description: 'text-only 模型也能看图：内置免费视觉链 + 像素级视觉工具（问答/定位/裁剪/OCR/抠图/截图）',
    source: 'npm',
    url: 'https://github.com/ysr666/dsh-vision-router'
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
    // 内置默认启用：新装（首次服务就绪）自动安装到 web profile 并注册进 dsh.profile.bundles（= 默认启用）
    installTarget: 'github:qgx1992/dsh-model-select-style',
    name: 'dsh-model-select-style',
    description: '输入框「模型选择」改版：供应商 + 模型两级联动按钮，选择逻辑复用官方组件',
    source: 'github',
    url: 'https://github.com/qgx1992/dsh-model-select-style',
    defaultEnabled: true
  },
  {
    // 内置默认启用：新装（首次服务就绪）自动安装到 web profile 并注册进 dsh.profile.bundles（= 默认启用）
    installTarget: 'github:qgx1992/dsh-workspace-collapse',
    name: 'dsh-workspace-collapse',
    description: '侧边栏底座：一键折叠/展开全部工作区分组（极简，不添加其他元素）',
    source: 'github',
    url: 'https://github.com/qgx1992/dsh-workspace-collapse',
    defaultEnabled: true
  }
]
