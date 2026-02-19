import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { createDefaultConfig, SECTIONS, type DeploymentConfig, type SectionKey } from '@/types'

const API_BASE = import.meta.env.VITE_API_URL || ''

export const useSetupStore = defineStore('setup', () => {
  // ── State ──
  const config = ref<DeploymentConfig>(createDefaultConfig())
  const activeSection = ref<SectionKey>('deployment')
  const deploying = ref(false)
  const deployStatus = ref<{ phase: string; message: string; log: string[]; complete: boolean; error: boolean }>({
    phase: 'idle',
    message: '',
    log: [],
    complete: false,
    error: false,
  })

  // ── Computed ──
  const sections = computed(() => SECTIONS)

  const completedSections = computed(() => {
    const done: SectionKey[] = []
    // A section is "complete" if at least one required field has a value
    if (config.value.deployment.serverIp && config.value.deployment.githubUser) done.push('deployment')
    if (config.value.core.siteUrl) done.push('core')
    if (config.value.database.password) done.push('database')
    if (config.value.keycloak.clientSecret || config.value.keycloak.adminPassword) done.push('keycloak')
    if (config.value.email.username) done.push('email')
    if (config.value.redis.host) done.push('redis')
    if (config.value.celery.brokerUrl) done.push('celery')
    if (config.value.stripe.testPublicKey || config.value.stripe.livePublicKey) done.push('stripe')
    if (config.value.paypal.testClientId || config.value.paypal.liveClientId) done.push('paypal')
    if (config.value.oscar.shopName) done.push('oscar')
    if (config.value.security.allowedDomains.length > 0) done.push('security')
    if (config.value.logging.logstashHost) done.push('logging')
    done.push('helpdesk', 'invoicing', 'policies', 'chat') // always have defaults
    if (config.value.business.countryCode) done.push('business')
    if (config.value.aws.accessKeyId) done.push('aws')
    if (config.value.cloudflare.apiToken) done.push('cloudflare')
    if (config.value.ssl.letsencryptEmail) done.push('ssl')
    if (config.value.nginx.containerName) done.push('nginx')
    if (config.value.system.mainHostname) done.push('system')
    return done
  })

  // ── Actions ──
  function setSection(key: SectionKey) {
    activeSection.value = key
  }

  async function detectIp() {
    try {
      const res = await fetch(`${API_BASE}/api/detect-ip`)
      const data = await res.json()
      if (data.ip) config.value.deployment.serverIp = data.ip
    } catch { /* ignore */ }
  }

  async function submitDeploy() {
    deploying.value = true
    deployStatus.value = { phase: 'starting', message: 'Submitting…', log: [], complete: false, error: false }

    try {
      const res = await fetch(`${API_BASE}/api/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config.value),
      })
      const data = await res.json()
      if (data.error) {
        deployStatus.value = { phase: 'error', message: data.error, log: [], complete: false, error: true }
        return
      }
      // Start polling
      pollStatus()
    } catch (err: any) {
      deployStatus.value = { phase: 'error', message: err.message, log: [], complete: false, error: true }
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null

  function pollStatus() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/deploy/status`)
        const data = await res.json()
        deployStatus.value = data
        if (data.complete || data.error) {
          if (pollTimer) clearInterval(pollTimer)
          pollTimer = null
          deploying.value = false
        }
      } catch { /* keep polling */ }
    }, 2000)
  }

  return {
    config,
    activeSection,
    deploying,
    deployStatus,
    sections,
    completedSections,
    setSection,
    detectIp,
    submitDeploy,
  }
})
