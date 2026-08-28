/**
 * dsh-notify 宿主（node 侧）入口。
 *
 * 本插件是「纯浏览器端」通知显示层：所有渲染逻辑都位于 client bundle
 * （lib/client.js，由 DSH 模块系统按 dsh.client.platform=web 组合成
 * /plugins/dsh-notify/client.js 提供给页面）。
 *
 * 宿主侧不提供任何行为 —— 与 dsh-ui-tools 相同的约定（浏览器半侧负责）
 * （参考 DSH-Exoskeleton 设计文档 NOTIFICATION-PLUGIN-DESIGN.md §6）。
 */
function apply() {}
export { apply }