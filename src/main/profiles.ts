/**
 * 配置档案管理（设计文档 docs/KERNEL-MANAGER-DESIGN.md §8，阶段 C）
 * - 每个档案可绑定内核版本；切换档案 = 切换内核（服务重启换内核，多内核 A/B）
 * - default 档案不可删除；档案名唯一；绑定内核需已安装（卸载时已有引用保护）
 */
import { configStore } from './config'
import { kernelManager } from './kernel-manager'
import type { DshProfile } from '../shared/types'

export function listProfiles(): DshProfile[] {
  return configStore.get().profiles ?? []
}

export function createProfile(name: string): { ok: boolean; error?: string; profile?: DshProfile } {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return { ok: false, error: '档案名称不能为空' }
  const cfg = configStore.get()
  const profiles = cfg.profiles ?? []
  if (profiles.some((p) => p.name === trimmed)) {
    return { ok: false, error: '档案「' + trimmed + '」已存在' }
  }
  const profile: DshProfile = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: trimmed,
    kernelVersion: null,
    createdAt: Date.now()
  }
  configStore.set({ profiles: [...profiles, profile] })
  return { ok: true, profile }
}

export function deleteProfile(id: string): { ok: boolean; error?: string } {
  const cfg = configStore.get()
  const profiles = cfg.profiles ?? []
  if (id === 'default') return { ok: false, error: '默认档案不可删除' }
  if (!profiles.some((p) => p.id === id)) return { ok: false, error: '档案不存在' }
  const next = profiles.filter((p) => p.id !== id)
  configStore.set({ profiles: next })
  if (cfg.activeProfileId === id) {
    configStore.set({ activeProfileId: 'default' })
  }
  return { ok: true }
}

export function activateProfile(id: string): { ok: boolean; error?: string } {
  const cfg = configStore.get()
  const profile = (cfg.profiles ?? []).find((p) => p.id === id)
  if (!profile) return { ok: false, error: '档案不存在' }
  if (cfg.activeProfileId === id) return { ok: true }
  // R-23: 校验绑定内核已安装（未安装则拒绝切换，避免静默回退 system dsh）
  if (profile.kernelVersion !== null && !kernelManager.listInstalled().some((k) => k.version === profile.kernelVersion)) {
    return { ok: false, error: '档案绑定的内核 v' + profile.kernelVersion + ' 未安装，请先在内核面板安装或解除绑定' }
  }
  configStore.set({ activeProfileId: id })
  return { ok: true }
}

export function setProfileKernel(id: string, version: string | null): { ok: boolean; error?: string } {
  const cfg = configStore.get()
  const profiles = cfg.profiles ?? []
  const idx = profiles.findIndex((p) => p.id === id)
  if (idx < 0) return { ok: false, error: '档案不存在' }
  if (version !== null && !kernelManager.listInstalled().some((k) => k.version === version)) {
    return { ok: false, error: '内核 v' + version + ' 未安装，请先在内核面板安装' }
  }
  const next = [...profiles]
  next[idx] = { ...next[idx], kernelVersion: version }
  configStore.set({ profiles: next })
  return { ok: true }
}
