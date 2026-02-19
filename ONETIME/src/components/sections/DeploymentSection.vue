<script setup lang="ts">
import { useSetupStore } from '@/stores/setup'
import TextInput from '@/components/fields/TextInput.vue'
import PasswordInput from '@/components/fields/PasswordInput.vue'
import TagInput from '@/components/fields/TagInput.vue'
import { ref } from 'vue'

const store = useSetupStore()
const c = store.config.deployment

// ── Backend subdomain input ──
const newSubdomain = ref('')
const activeBackendDomain = ref('')

function addBackendDomain() {
  const val = prompt('Enter a backend root domain (e.g., example.com)')
  if (val && !c.backendDomains.includes(val.trim())) {
    c.backendDomains.push(val.trim())
    c.backendSubdomains[val.trim()] = []
  }
}

function removeBackendDomain(idx: number) {
  const domain = c.backendDomains[idx]
  c.backendDomains.splice(idx, 1)
  if (domain) delete c.backendSubdomains[domain]
}

function addSubdomain(domain: string) {
  if (!newSubdomain.value.trim()) return
  if (!c.backendSubdomains[domain]) c.backendSubdomains[domain] = []
  if (!c.backendSubdomains[domain].includes(newSubdomain.value.trim())) {
    c.backendSubdomains[domain].push(newSubdomain.value.trim())
  }
  newSubdomain.value = ''
}

function removeSubdomain(domain: string, idx: number) {
  c.backendSubdomains[domain]?.splice(idx, 1)
}

function addFrontendDomain() {
  c.frontendDomains.push({ domain: '', container: 'onedash', isWildcard: false })
}

function removeFrontendDomain(idx: number) {
  c.frontendDomains.splice(idx, 1)
}

function addRepository() {
  c.repositories.push({ url: '', folder: '', domain: '', type: 'frontend', container: 'onedash' })
}

function removeRepository(idx: number) {
  c.repositories.splice(idx, 1)
}

store.detectIp()
</script>

<template>
  <div class="section">
    <h2 class="section-title">🚀 Deployment Configuration</h2>
    <p class="section-desc">Server credentials, repositories, and domain mapping required by the deploy script.</p>

    <!-- Server IP -->
    <div class="card">
      <h3 class="card-title">Server</h3>
      <TextInput v-model="c.serverIp" label="Server Public IP" placeholder="e.g., 52.100.12.1" help-text="Auto-detected if possible. This IP is used for DNS A records." required />
      <button type="button" class="btn-secondary" @click="store.detectIp()">Auto-detect IP</button>
    </div>

    <!-- GitHub -->
    <div class="card">
      <h3 class="card-title">GitHub Credentials</h3>
      <p class="card-desc">GitHub expects a Token as password when cloning private repositories.</p>
      <TextInput v-model="c.githubUser" label="GitHub Username / Email" placeholder="user@example.com" required />
      <PasswordInput v-model="c.githubToken" label="GitHub Token" placeholder="ghp_..." required />
    </div>

    <!-- SSL / Let's Encrypt -->
    <div class="card">
      <h3 class="card-title">SSL Certificate</h3>
      <TextInput v-model="c.letsencryptEmail" label="Let's Encrypt Email" type="email" placeholder="admin@example.com" help-text="Used for certificate notifications and account recovery." required />
      <PasswordInput v-model="c.cloudflareApiToken" label="Cloudflare API Token" placeholder="API token with DNS edit permissions" help-text="Used for DNS-01 challenge to generate wildcard SSL certificates." required />
    </div>

    <!-- Repositories → Domain mapping -->
    <div class="card">
      <h3 class="card-title">Repositories</h3>
      <p class="card-desc">Map each repository to a folder name & which domain it will serve.</p>

      <div v-for="(repo, idx) in c.repositories" :key="idx" class="repo-row">
        <div class="repo-header">
          <span class="repo-type-badge" :class="repo.type">{{ repo.type }}</span>
          <button v-if="c.repositories.length > 1" type="button" class="btn-remove" @click="removeRepository(idx)">✕</button>
        </div>
        <TextInput v-model="repo.url" label="Repository URL" placeholder="https://github.com/org/repo.git" />
        <TextInput v-model="repo.folder" label="Folder Name" placeholder="e.g., BACKEND-API-HCOM" />
        <TextInput v-model="repo.domain" label="Domain" placeholder="e.g., request.example.com" />
        <div class="field">
          <label class="field-label">Type</label>
          <select v-model="repo.type" class="field-select">
            <option value="backend">Backend (Django)</option>
            <option value="frontend">Frontend (Vue3 Dashboard)</option>
            <option value="homepage">Homepage</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label">Container</label>
          <select v-model="repo.container" class="field-select">
            <option value="backend">backend</option>
            <option value="onedash">onedash</option>
            <option value="homepage">homepage</option>
            <option value="demo">demo</option>
          </select>
        </div>
      </div>
      <button type="button" class="btn-secondary" @click="addRepository()">+ Add Repository</button>
    </div>

    <!-- Backend Domains + Subdomains -->
    <div class="card">
      <h3 class="card-title">Backend Root Domains</h3>
      <p class="card-desc">Wildcard SSL (*.domain.com) will be issued for each root domain. Then specify subdomains that proxy to the backend.</p>

      <div v-for="(domain, idx) in c.backendDomains" :key="domain" class="domain-block">
        <div class="domain-header">
          <code>*.{{ domain }}</code>
          <button type="button" class="btn-remove" @click="removeBackendDomain(idx)">✕</button>
        </div>
        <div class="subdomain-list">
          <span v-for="(sub, si) in c.backendSubdomains[domain] || []" :key="si" class="tag">
            {{ sub }}.{{ domain }}
            <button type="button" class="tag-remove" @click="removeSubdomain(domain, si)">×</button>
          </span>
        </div>
        <div class="subdomain-add">
          <input
            v-model="newSubdomain"
            placeholder="subdomain (e.g., api)"
            class="field-input small"
            @focus="activeBackendDomain = domain"
            @keydown.enter.prevent="addSubdomain(domain)"
          />
          <button type="button" class="btn-secondary small" @click="addSubdomain(domain)">Add</button>
        </div>
      </div>
      <button type="button" class="btn-secondary" @click="addBackendDomain()">+ Add Backend Domain</button>
    </div>

    <!-- Frontend Domains -->
    <div class="card">
      <h3 class="card-title">Frontend Domains</h3>
      <p class="card-desc">Map each frontend domain to a container (onedash, homepage, demo).</p>

      <div v-for="(fe, idx) in c.frontendDomains" :key="idx" class="fe-row">
        <TextInput v-model="fe.domain" label="Domain" placeholder="onedash.example.com" />
        <div class="field">
          <label class="field-label">Container</label>
          <select v-model="fe.container" class="field-select">
            <option value="onedash">onedash</option>
            <option value="homepage">homepage</option>
            <option value="demo">demo</option>
          </select>
        </div>
        <label class="checkbox-row">
          <input type="checkbox" v-model="fe.isWildcard" />
          <span>Also serve *.rootdomain (wildcard)</span>
        </label>
        <button type="button" class="btn-remove" @click="removeFrontendDomain(idx)">✕</button>
      </div>
      <button type="button" class="btn-secondary" @click="addFrontendDomain()">+ Add Frontend Domain</button>
    </div>
  </div>
</template>

<style scoped>
.section { display: flex; flex-direction: column; gap: 24px; }
.section-title { font-size: 22px; font-weight: 700; color: var(--text-heading); }
.section-desc { color: var(--text-muted); font-size: 14px; margin-top: -16px; }
.card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }
.card-title { font-size: 16px; font-weight: 600; color: var(--text-heading); margin-bottom: 8px; }
.card-desc { font-size: 13px; color: var(--text-muted); margin-bottom: 16px; }
.btn-secondary {
  padding: 8px 16px; background: transparent; border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--primary); cursor: pointer; font-size: 13px;
  transition: all 0.2s;
}
.btn-secondary:hover { background: rgba(59,130,246,0.1); border-color: var(--primary); }
.btn-secondary.small { padding: 6px 12px; font-size: 12px; }
.btn-remove { background: none; border: none; color: var(--danger); cursor: pointer; font-size: 16px; }
.repo-row { border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 12px; }
.repo-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.repo-type-badge {
  padding: 2px 10px; border-radius: 10px; font-size: 11px; font-weight: 600; text-transform: uppercase;
}
.repo-type-badge.backend { background: rgba(239,68,68,0.15); color: #f87171; }
.repo-type-badge.frontend { background: rgba(59,130,246,0.15); color: #60a5fa; }
.repo-type-badge.homepage { background: rgba(16,185,129,0.15); color: #34d399; }
.domain-block { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; margin-bottom: 12px; }
.domain-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.domain-header code { color: var(--primary); font-size: 14px; }
.subdomain-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.subdomain-add { display: flex; gap: 8px; }
.tag { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; background: var(--primary); color: white; border-radius: 12px; font-size: 12px; }
.tag-remove { background: none; border: none; color: white; cursor: pointer; font-size: 14px; opacity: 0.7; }
.tag-remove:hover { opacity: 1; }
.fe-row { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; margin-bottom: 12px; }
.checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-muted); margin-bottom: 8px; cursor: pointer; }
.field { margin-bottom: 16px; }
.field-label { display: block; font-size: 13px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
.field-select {
  width: 100%; padding: 10px 14px; background: var(--bg-input); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text); font-size: 14px; cursor: pointer;
}
.field-input { width: 100%; padding: 10px 14px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); font-size: 14px; }
.field-input.small { padding: 6px 10px; font-size: 13px; }
.field-input:focus, .field-select:focus { outline: none; border-color: var(--primary); }
</style>
