/**
 * @shared 版本号逐段比较
 * R-22：绝不使用字符串比较判定版本大小（原实现曾把 rc.10 误判低于 rc.2）。
 * 独立成模块供 kernel-manager 与 plugins 共用，保证「是否有新版本」判定口径一致。
 */

/** 简单 semver 比较：返回 a>b ? 1 : a<b ? -1 : 0（prerelease 视为低于同 base 稳定版） */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { base: number[]; pre: string } => {
    const parts = v.split('-')
    return {
      base: (parts[0] ?? '0').split('.').map((n) => parseInt(n, 10) || 0),
      pre: parts.slice(1).join('-')
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.base.length, pb.base.length)
  for (let i = 0; i < len; i++) {
    const x = pa.base[i] ?? 0
    const y = pb.base[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1 // 稳定版 > prerelease
  if (!pb.pre) return -1
  // R-22: prerelease 逐段比较（数字段数值比较、标识符字典序、数字 < 标识符、段多 > 段少）
  const paParts = pa.pre.split('.')
  const pbParts = pb.pre.split('.')
  const n = Math.max(paParts.length, pbParts.length)
  for (let i = 0; i < n; i++) {
    const x = i < paParts.length ? paParts[i] : undefined
    const y = i < pbParts.length ? pbParts[i] : undefined
    if (x === y) continue
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const xn = parseInt(x, 10)
      const yn = parseInt(y, 10)
      if (xn !== yn) return xn > yn ? 1 : -1
    } else if (xNum) {
      return -1 // 数字标识符 < 字母标识符
    } else if (yNum) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}