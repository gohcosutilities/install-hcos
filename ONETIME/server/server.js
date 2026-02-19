import express from 'express';
import cors from 'cors';
import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.ONETIME_PORT || 9090;
const BASE_DIR = process.env.BASE_DIR || '/opt/hcos_stack';

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve the Vue3 frontend (production build)
const distPath = join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
}

// Track deployment status
let deploymentStatus = { phase: 'idle', message: '', log: [], complete: false, error: false };

// ─── Health check ───
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', phase: deploymentStatus.phase });
});

// ─── Get deployment status (polled by frontend) ───
app.get('/api/deploy/status', (_req, res) => {
  res.json(deploymentStatus);
});

// ─── Detect server public IP ───
app.get('/api/detect-ip', async (_req, res) => {
  try {
    const result = execSync('curl -s -4 ifconfig.me || curl -s -4 icanhazip.com || echo ""', {
      timeout: 10000,
    }).toString().trim();
    res.json({ ip: result });
  } catch {
    res.json({ ip: '' });
  }
});

// ─── Submit deployment configuration ───
app.post('/api/deploy', async (req, res) => {
  if (deploymentStatus.phase !== 'idle' && !deploymentStatus.complete && !deploymentStatus.error) {
    return res.status(409).json({ error: 'Deployment already in progress' });
  }

  const config = req.body;

  // Reset status
  deploymentStatus = { phase: 'starting', message: 'Received configuration…', log: [], complete: false, error: false };

  // Acknowledge immediately — run deployment async
  res.json({ status: 'started', message: 'Deployment initiated' });

  try {
    await runDeployment(config);
  } catch (err) {
    appendLog(`FATAL: ${err.message}`);
    deploymentStatus.phase = 'error';
    deploymentStatus.error = true;
    deploymentStatus.message = err.message;
  }
});

// SPA fallback
app.get('*', (_req, res) => {
  const index = join(distPath, 'index.html');
  if (existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(200).send('ONETIME setup server running. Build the Vue frontend first.');
  }
});

// ─── Deployment orchestration ───

function appendLog(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  deploymentStatus.log.push(line);
  console.log(line);
}

function run(cmd, opts = {}) {
  appendLog(`$ ${cmd}`);
  try {
    const output = execSync(cmd, { cwd: opts.cwd || BASE_DIR, timeout: opts.timeout || 300000, encoding: 'utf-8', stdio: 'pipe' });
    if (output) appendLog(output.substring(0, 2000));
    return output;
  } catch (err) {
    appendLog(`ERROR: ${err.stderr?.substring(0, 1000) || err.message}`);
    if (!opts.allowFailure) throw err;
    return '';
  }
}

async function runDeployment(config) {
  // ── Phase 1: Write .env file ──
  deploymentStatus.phase = 'env';
  deploymentStatus.message = 'Writing environment configuration…';
  appendLog('Phase 1: Writing .env file');

  mkdirSync(BASE_DIR, { recursive: true });
  writeEnvFile(config);

  // ── Phase 2: Write Cloudflare credentials ──
  deploymentStatus.phase = 'cloudflare';
  deploymentStatus.message = 'Configuring Cloudflare credentials…';
  appendLog('Phase 2: Cloudflare credentials');

  const cfCredsPath = '/opt/cf_creds.ini';
  writeFileSync(cfCredsPath, `dns_cloudflare_api_token = ${config.cloudflare.apiToken}\n`);
  chmodSync(cfCredsPath, 0o400);

  // ── Phase 3: Clone repositories ──
  deploymentStatus.phase = 'clone';
  deploymentStatus.message = 'Cloning repositories…';
  appendLog('Phase 3: Cloning repositories');

  cloneRepositories(config);

  // ── Phase 4: Generate SSL certificates ──
  deploymentStatus.phase = 'ssl';
  deploymentStatus.message = 'Generating SSL certificates…';
  appendLog('Phase 4: SSL certificates');

  generateSSL(config);

  // ── Phase 5: Create Cloudflare DNS records ──
  deploymentStatus.phase = 'dns';
  deploymentStatus.message = 'Creating DNS records…';
  appendLog('Phase 5: DNS records');

  createDNSRecords(config);

  // ── Phase 6: Generate Nginx config ──
  deploymentStatus.phase = 'nginx';
  deploymentStatus.message = 'Generating Nginx configuration…';
  appendLog('Phase 6: Nginx config');

  generateNginxConfig(config);

  // ── Phase 7: Generate docker-compose.yml ──
  deploymentStatus.phase = 'compose';
  deploymentStatus.message = 'Generating docker-compose.yml…';
  appendLog('Phase 7: docker-compose.yml');

  generateDockerCompose(config);

  // ── Phase 8: Start Docker stack ──
  deploymentStatus.phase = 'docker';
  deploymentStatus.message = 'Starting Docker stack (this may take several minutes)…';
  appendLog('Phase 8: docker compose up');

  run('docker compose down 2>/dev/null || true', { allowFailure: true });
  run('docker compose up -d --build', { timeout: 600000 });

  // ── Phase 9: Run Django migrations ──
  deploymentStatus.phase = 'migrations';
  deploymentStatus.message = 'Running Django migrations…';
  appendLog('Phase 9: Django migrations');

  await new Promise(r => setTimeout(r, 15000));  // wait for services
  run('docker compose exec -T backend python manage.py migrate --noinput', { allowFailure: true });
  run('docker compose exec -T backend python manage.py create_base_products', { allowFailure: true });
  run('docker compose exec -T backend python manage.py collectstatic --noinput', { allowFailure: true });

  // ── Phase 10: Configure host Nginx ──
  deploymentStatus.phase = 'host-nginx';
  deploymentStatus.message = 'Configuring host Nginx…';
  appendLog('Phase 10: Host Nginx');

  configureHostNginx(config);

  // ── Done ──
  deploymentStatus.phase = 'complete';
  deploymentStatus.message = 'Deployment complete!';
  deploymentStatus.complete = true;
  appendLog('Deployment finished successfully.');
}

// ─── Helper: Write .env file ───
function writeEnvFile(config) {
  const lines = [];
  const add = (key, val) => { if (val !== undefined && val !== null && val !== '') lines.push(`${key}=${val}`); };

  // Core
  add('DJANGO_SECRET_KEY', config.core.secretKey);
  add('DEBUG', config.core.debug);
  add('SITE', config.core.siteUrl);
  add('SITE_DOMAIN', config.core.siteDomain);
  add('APP_NAME', config.core.appName);
  add('SYSTEM_PIN', config.core.systemPin);
  add('SYSTEM_PIN_CODE_LENGTH', config.core.systemPinLength);
  add('DISABLE_DNS_VERIFICATION', config.core.disableDnsVerification);
  add('FRONTEND_URL', config.core.frontendUrl);

  // Database
  add('BACKEND_DB', config.database.name);
  add('POSTGRES_DB', config.database.name);
  add('BACKEND_USER', config.database.user);
  add('POSTGRES_USER', config.database.user);
  add('BACKEND_PASSWORD', config.database.password);
  add('POSTGRES_PASSWORD', config.database.password);
  add('POSTGRES_HOST', config.database.host);
  add('POSTGRES_PORT', config.database.port);

  // Keycloak
  add('KEYCLOAK_SERVER_URL', config.keycloak.serverUrl);
  add('KEYCLOAK_PUBLIC_URL', config.keycloak.publicUrl);
  add('KEYCLOAK_REALM_NAME', config.keycloak.realmName);
  add('KEYCLOAK_CLIENT_ID', config.keycloak.clientId);
  add('KEYCLOAK_CLIENT_SECRET', config.keycloak.clientSecret);
  add('KEYCLOAK_ADMIN_USERNAME', config.keycloak.adminUsername);
  add('KEYCLOAK_ADMIN_PASSWORD', config.keycloak.adminPassword);
  add('KEYCLOAK_FRONTEND_CLIENT_ID', config.keycloak.frontendClientId);
  add('KEYCLOAK_ENABLED', config.keycloak.enabled);

  // Email
  add('EMAIL_BACKEND', config.email.backend);
  add('EMAIL_HOST', config.email.host);
  add('EMAIL_PORT', config.email.port);
  add('EMAIL_USE_TLS', config.email.useTls);
  add('EMAIL_USE_SSL', config.email.useSsl);
  add('EMAIL_HOST_USER', config.email.username);
  add('EMAIL_HOST_PASSWORD', config.email.password);
  add('DEFAULT_FROM_EMAIL', config.email.fromEmail);

  // Redis/Channels
  add('CHANNELS_REDIS_HOST', config.redis.host);
  add('CHANNELS_REDIS_PORT', config.redis.port);

  // Celery
  add('CELERY_BROKER_URL', config.celery.brokerUrl);
  add('CELERY_RESULT_BACKEND', config.celery.resultBackend);

  // Stripe
  add('STRIPE_LIVE_MODE', config.stripe.liveMode);
  add('STRIPE_TEST_PUBLIC_KEY', config.stripe.testPublicKey);
  add('STRIPE_TEST_SECRET_KEY', config.stripe.testSecretKey);
  add('STRIPE_LIVE_PUBLIC_KEY', config.stripe.livePublicKey);
  add('STRIPE_LIVE_SECRET_KEY', config.stripe.liveSecretKey);
  add('DJSTRIPE_WEBHOOK_SECRET', config.stripe.webhookSecret);

  // PayPal
  add('PAYPAL_MODE', config.paypal.mode);
  add('PAYPAL_TEST_CLIENT_ID', config.paypal.testClientId);
  add('PAYPAL_TEST_SECRET', config.paypal.testSecret);
  add('PAYPAL_LIVE_CLIENT_ID', config.paypal.liveClientId);
  add('PAYPAL_LIVE_SECRET', config.paypal.liveSecret);

  // Oscar
  add('OSCAR_SHOP_NAME', config.oscar.shopName);
  add('OSCAR_DEFAULT_CURRENCY', config.oscar.defaultCurrency);
  add('SHOP_TAX_RATE', config.oscar.taxRate);

  // Security / CORS
  add('ALLOWED_DOMAINS', (config.security.allowedDomains || []).join(','));
  add('CORS_ALLOWED_ORIGINS', (config.security.corsOrigins || []).join(','));

  // Cloudflare
  add('CLOUDFLARE_API_TOKEN', config.cloudflare.apiToken);
  add('CLOUDFLARE_API_KEY', config.cloudflare.apiKey);
  add('CLOUDFLARE_API_EMAIL', config.cloudflare.apiEmail);
  add('CLOUDFLARE_ACCOUNT_ID', config.cloudflare.accountId);
  add('CLOUDFLARE_ZONE_ID', config.cloudflare.zoneId);

  // SSL
  add('WILDCARD_SSL_ENABLED', config.ssl.wildcardEnabled);
  add('CERTBOT_LETSENCRYPT_EMAIL', config.ssl.letsencryptEmail);

  // System
  add('SYSTEM_MAIN_HOSTNAME', config.system.mainHostname);
  add('SYSTEM_MAIN_IP_ADDRESS', config.deployment.serverIp);

  const envContent = lines.join('\n') + '\n';
  const envPath = join(BASE_DIR, '.env');
  writeFileSync(envPath, envContent);
  // Also write to backend dir if it exists
  const backendEnv = join(BASE_DIR, 'BACKEND-API-HCOM', '.env');
  if (existsSync(join(BASE_DIR, 'BACKEND-API-HCOM'))) {
    writeFileSync(backendEnv, envContent);
  }
  appendLog(`.env written to ${envPath}`);
}

// ─── Helper: Clone repositories ───
function cloneRepositories(config) {
  const { githubUser, githubToken } = config.deployment;
  const repos = config.deployment.repositories || [];

  for (const repo of repos) {
    const folder = repo.folder;
    const fullPath = join(BASE_DIR, folder);

    if (existsSync(fullPath)) {
      appendLog(`Removing existing ${folder}…`);
      run(`rm -rf "${fullPath}"`, { cwd: '/' });
    }

    const authUrl = repo.url.replace('https://', `https://${githubUser}:${githubToken}@`);
    appendLog(`Cloning ${repo.url} → ${folder}`);
    run(`git clone "${authUrl}" "${fullPath}"`, { cwd: '/', timeout: 120000 });
  }

  // After cloning, write .env into the backend folder
  const backendFolder = repos.find(r => r.type === 'backend')?.folder;
  if (backendFolder) {
    const srcEnv = join(BASE_DIR, '.env');
    const dstEnv = join(BASE_DIR, backendFolder, '.env');
    if (existsSync(srcEnv)) {
      writeFileSync(dstEnv, readFileSync(srcEnv, 'utf-8'));
      appendLog(`.env copied to ${dstEnv}`);
    }
  }
}

// ─── Helper: Generate SSL ───
function generateSSL(config) {
  const email = config.ssl.letsencryptEmail;
  const backendDomains = config.deployment.backendDomains || [];

  for (const domain of backendDomains) {
    appendLog(`Generating wildcard cert for ${domain}…`);
    run(
      `certbot certonly --non-interactive --agree-tos --email "${email}" ` +
      `--dns-cloudflare --dns-cloudflare-credentials /opt/cf_creds.ini ` +
      `--dns-cloudflare-propagation-seconds 60 -d "${domain}" -d "*.${domain}"`,
      { cwd: '/', timeout: 180000, allowFailure: true }
    );
  }

  // Copy primary cert into project certbot dir for docker mount
  if (backendDomains.length > 0) {
    const primary = backendDomains[0];
    const certSrc = `/etc/letsencrypt/live/${primary}`;
    const certDst = join(BASE_DIR, 'certbot', 'conf');
    mkdirSync(certDst, { recursive: true });
    run(`cp -rL ${certSrc}/fullchain.pem ${certDst}/fullchain.pem`, { cwd: '/', allowFailure: true });
    run(`cp -rL ${certSrc}/privkey.pem ${certDst}/privkey.pem`, { cwd: '/', allowFailure: true });
  }
}

// ─── Helper: Create DNS records ───
function createDNSRecords(config) {
  const token = config.cloudflare.apiToken;
  const ip = config.deployment.serverIp;

  // Collect all domains
  const allDomains = [
    ...(config.deployment.backendDomains || []),
    ...(config.deployment.frontendDomains?.map(f => f.domain) || []),
  ];

  for (const domain of allDomains) {
    // Get zone ID
    const rootDomain = domain.split('.').slice(-2).join('.');
    appendLog(`Getting zone ID for ${rootDomain}…`);
    const zoneResult = run(
      `curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=${rootDomain}" ` +
      `-H "Authorization: Bearer ${token}" -H "Content-Type: application/json"`,
      { cwd: '/', allowFailure: true }
    );

    let zoneId = '';
    try {
      const parsed = JSON.parse(zoneResult);
      zoneId = parsed?.result?.[0]?.id || '';
    } catch { /* ignore */ }

    if (!zoneId) {
      appendLog(`Could not find zone ID for ${rootDomain}, skipping DNS.`);
      continue;
    }

    // A record
    run(
      `curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records" ` +
      `-H "Authorization: Bearer ${token}" -H "Content-Type: application/json" ` +
      `--data '{"type":"A","name":"${domain}","content":"${ip}","ttl":120,"proxied":false}'`,
      { cwd: '/', allowFailure: true }
    );
    appendLog(`A record created for ${domain}`);
  }

  // Backend subdomains
  const subdomainMap = config.deployment.backendSubdomains || {};
  for (const [rootDomain, subdomains] of Object.entries(subdomainMap)) {
    const rootDom = rootDomain.split('.').slice(-2).join('.');
    const zoneResult = run(
      `curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=${rootDom}" ` +
      `-H "Authorization: Bearer ${token}" -H "Content-Type: application/json"`,
      { cwd: '/', allowFailure: true }
    );
    let zoneId = '';
    try { zoneId = JSON.parse(zoneResult)?.result?.[0]?.id || ''; } catch { /* */ }
    if (!zoneId) continue;

    for (const sub of subdomains) {
      run(
        `curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records" ` +
        `-H "Authorization: Bearer ${token}" -H "Content-Type: application/json" ` +
        `--data '{"type":"A","name":"${sub}.${rootDomain}","content":"${ip}","ttl":120,"proxied":false}'`,
        { cwd: '/', allowFailure: true }
      );
      appendLog(`A record for ${sub}.${rootDomain}`);
    }
  }
}

// ─── Helper: Nginx config ───
function generateNginxConfig(config) {
  const nginxDir = join(BASE_DIR, 'nginx', 'templates');
  mkdirSync(nginxDir, { recursive: true });

  const backendDomains = config.deployment.backendDomains || [];
  const subdomainMap = config.deployment.backendSubdomains || {};
  const frontendDomains = config.deployment.frontendDomains || [];
  const primaryDomain = backendDomains[0] || 'example.com';

  let conf = `upstream backend_upstream { server backend:5000; }\n`;
  conf += `upstream keycloak_backend { server keycloak:3001; }\n\n`;

  // Keycloak server block
  conf += `server {
    listen 443 ssl http2;
    server_name key.${primaryDomain};
    ssl_certificate /etc/letsencrypt/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    location / {
        proxy_pass http://keycloak_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
    }
}\n\n`;

  // Backend subdomain blocks
  for (const rootDomain of backendDomains) {
    const subs = subdomainMap[rootDomain] || [];
    for (const sub of subs) {
      conf += `server {
    listen 443 ssl;
    server_name ${sub}.${rootDomain};
    ssl_certificate /etc/letsencrypt/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    location /ws/ {
        proxy_pass https://backend_upstream;
        proxy_ssl_verify off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
    }
    location / {
        proxy_pass https://backend_upstream;
        proxy_ssl_verify off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}\n\n`;
    }
  }

  // Frontend blocks
  for (const fe of frontendDomains) {
    const root = fe.container === 'homepage' ? '/var/www/homepage' :
                 fe.container === 'demo' ? '/var/www/demo' : '/var/www/onedash';
    
    // Wildcard block for onedash
    if (fe.container === 'onedash' && fe.isWildcard) {
      conf += `server {
    listen 443 ssl;
    server_name *.${primaryDomain};
    ssl_certificate /etc/letsencrypt/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    root ${root};
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}\n\n`;
    }

    conf += `server {
    listen 443 ssl;
    server_name ${fe.domain};
    ssl_certificate /etc/letsencrypt/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    root ${root};
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}\n\n`;
  }

  // HTTP → HTTPS redirect
  const allNames = [
    ...frontendDomains.map(f => f.domain),
    ...backendDomains.flatMap(d => (subdomainMap[d] || []).map(s => `${s}.${d}`)),
    `key.${primaryDomain}`,
  ].join(' ');

  conf += `server {
    listen 80;
    server_name ${allNames};
    return 301 https://$host$request_uri;
}\n`;

  writeFileSync(join(nginxDir, 'default.conf.template'), conf);
  appendLog('Nginx config written.');
}

// ─── Helper: docker-compose.yml ───
function generateDockerCompose(config) {
  const repos = config.deployment.repositories || [];
  const backendRepo = repos.find(r => r.type === 'backend');
  const frontendRepo = repos.find(r => r.type === 'frontend');
  const homepageRepo = repos.find(r => r.type === 'homepage');

  const backendDir = backendRepo?.folder || 'BACKEND-API-HCOM';
  const frontendDir = frontendRepo?.folder || 'ONEDASH.HCOS.IO';
  const homepageDir = homepageRepo?.folder || 'HOMEPAGE';

  const primaryDomain = (config.deployment.backendDomains || ['example.com'])[0];

  const yml = `services:
  postgres:
    image: postgres:14-alpine
    container_name: postgres
    environment:
      POSTGRES_DB: \${POSTGRES_DB:-hcos_db}
      POSTGRES_USER: \${POSTGRES_USER:-hcos_user}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-hcos_password}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-multiple-databases.sh:/docker-entrypoint-initdb.d/init-multiple-databases.sh:ro
    networks:
      - keycloak_internal
    ports:
      - "5432:5432"

  redis:
    image: redis:alpine
    networks:
      - keycloak_internal

  keycloak:
    build:
      context: ./keycloak
    container_name: keycloak
    command: start --optimized
    environment:
      - KC_PROXY_HEADERS=xforwarded
      - KC_HOSTNAME=https://key.${primaryDomain}
      - KC_HOSTNAME_STRICT=true
      - KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true
      - KC_HTTP_ENABLED=true
      - KC_HTTP_PORT=3001
      - KEYCLOAK_ADMIN=admin
      - KEYCLOAK_ADMIN_PASSWORD=\${KEYCLOAK_ADMIN_PASSWORD:-admin}
      - KC_DB=postgres
      - KC_DB_URL=jdbc:postgresql://postgres:5432/keycloakdb
      - KC_DB_USERNAME=\${POSTGRES_USER:-hcos_user}
      - KC_DB_PASSWORD=\${POSTGRES_PASSWORD:-hcos_password}
    ports:
      - "3001:3001"
    networks:
      - keycloak_internal
    depends_on:
      - postgres

  backend:
    build:
      context: ./${backendDir}
    container_name: backend_service
    command: daphne -v 2 -e ssl:port=5000:privateKey=/etc/letsencrypt/privkey.pem:certKey=/etc/letsencrypt/fullchain.pem hcos.asgi:application
    volumes:
      - ./${backendDir}:/app
      - ./certbot/conf:/etc/letsencrypt:ro
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - DATABASE_URL=postgres://\${POSTGRES_USER:-hcos_user}:\${POSTGRES_PASSWORD:-hcos_password}@postgres:5432/\${POSTGRES_DB:-hcos_db}
      - CELERY_BROKER_URL=redis://redis:6379/0
      - CELERY_RESULT_BACKEND=redis://redis:6379/0
      - CHANNELS_REDIS_HOST=redis
      - CHANNELS_REDIS_PORT=6379
    depends_on:
      - postgres
      - redis
    networks:
      - keycloak_internal
    extra_hosts:
      - "key.${primaryDomain}:host-gateway"
      - "internal.local:host-gateway"
      - "postgres.local:host-gateway"
    ports:
      - "5000:5000"

  celery:
    build:
      context: ./${backendDir}
    container_name: celery_worker
    command: celery -A hcos worker -l info -E
    volumes:
      - ./${backendDir}:/app
    environment:
      - DATABASE_URL=postgres://\${POSTGRES_USER:-hcos_user}:\${POSTGRES_PASSWORD:-hcos_password}@postgres:5432/\${POSTGRES_DB:-hcos_db}
      - CELERY_BROKER_URL=redis://redis:6379/0
      - CELERY_RESULT_BACKEND=redis://redis:6379/0
    depends_on:
      - postgres
      - redis
      - backend
    networks:
      - keycloak_internal

  celery-beat:
    build:
      context: ./${backendDir}
    container_name: celery_beat
    command: celery -A hcos beat -l info
    volumes:
      - ./${backendDir}:/app
    environment:
      - DATABASE_URL=postgres://\${POSTGRES_USER:-hcos_user}:\${POSTGRES_PASSWORD:-hcos_password}@postgres:5432/\${POSTGRES_DB:-hcos_db}
      - CELERY_BROKER_URL=redis://redis:6379/0
      - CELERY_RESULT_BACKEND=redis://redis:6379/0
    depends_on:
      - postgres
      - redis
      - backend
    networks:
      - keycloak_internal

  nginx_main:
    image: nginx:latest
    container_name: nginx_main
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/templates:/etc/nginx/templates
      - ./certbot/conf:/etc/letsencrypt:ro
      - ./${frontendDir}/dist:/var/www/onedash
      - ./${homepageDir}/dist:/var/www/homepage
    depends_on:
      - backend
      - keycloak
    networks:
      - keycloak_internal

networks:
  keycloak_internal:
    driver: bridge

volumes:
  postgres_data:
    driver: local
`;

  writeFileSync(join(BASE_DIR, 'docker-compose.yml'), yml);
  appendLog('docker-compose.yml written.');
}

// ─── Helper: Host Nginx ───
function configureHostNginx(config) {
  // Only relevant on production servers with host nginx; skip in Docker-only setups
  try {
    run('which nginx', { cwd: '/', allowFailure: true });
    const isInstalled = existsSync('/usr/sbin/nginx');
    if (!isInstalled) {
      appendLog('Host Nginx not installed, skipping host config.');
      return;
    }

    appendLog('Host Nginx detected — container Nginx handles SSL termination, skipping host proxy config.');
  } catch {
    appendLog('Host Nginx configuration skipped.');
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`══════════════════════════════════════════════════`);
  console.log(`  ONETIME Setup Server running on port ${PORT}`);
  console.log(`  Open http://<server-ip>:${PORT} to configure`);
  console.log(`══════════════════════════════════════════════════`);
});
