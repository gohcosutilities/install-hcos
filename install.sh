#!/usr/bin/env bash
###############################################################################
# HCOS One-Line Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gohcosutilities/install-hcos/main/install.sh | bash
#
# This script:
#   1. Checks for / installs Docker & Docker Compose
#   2. Clones the PUBLIC deployment infrastructure repo (install-hcos)
#   3. Builds and starts the ONETIME setup container
#   4. Prints the URL to access the setup wizard
#
# The 3 private application repos are cloned LATER by the setup wizard
# using the GitHub credentials you provide in the web form.
###############################################################################

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No color

# ── This repo is PUBLIC — contains docker-compose.yml, ONETIME/, nginx/, keycloak/ ──
REPO_URL="https://github.com/gohcosutilities/install-hcos.git"
PROJECT_DIR="$HOME/HCOS-DEPLOY"

print_banner() {
  echo -e "${CYAN}"
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║          HCOS Deployment Installer        ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo -e "${NC}"
}

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ── Detect OS ──
detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="$ID"
    OS_LIKE="${ID_LIKE:-$ID}"
  elif [ -f /etc/redhat-release ]; then
    OS_ID="rhel"
    OS_LIKE="rhel"
  else
    OS_ID="unknown"
    OS_LIKE="unknown"
  fi
  log_info "Detected OS: $OS_ID ($OS_LIKE)"
}

# ── Install Docker ──
install_docker() {
  if command -v docker &>/dev/null; then
    log_success "Docker is already installed: $(docker --version)"
    return
  fi

  log_info "Installing Docker..."

  case "$OS_LIKE" in
    *debian*|*ubuntu*)
      sudo apt-get update -qq
      sudo apt-get install -y -qq ca-certificates curl gnupg
      sudo install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/$OS_ID/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
      sudo chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_ID $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
        sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
      sudo apt-get update -qq
      sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    *rhel*|*centos*|*fedora*|*amzn*)
      sudo yum install -y yum-utils
      sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
      sudo yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      sudo systemctl start docker
      sudo systemctl enable docker
      ;;
    *)
      log_warn "Unknown OS. Attempting universal install script..."
      curl -fsSL https://get.docker.com | sh
      ;;
  esac

  # Add current user to docker group
  if ! groups | grep -q docker; then
    sudo usermod -aG docker "$USER" 2>/dev/null || true
  fi

  # Start Docker if not running
  if ! sudo systemctl is-active --quiet docker 2>/dev/null; then
    sudo systemctl start docker 2>/dev/null || sudo service docker start 2>/dev/null || true
  fi

  log_success "Docker installed: $(docker --version)"
}

# ── Check Docker Compose ──
check_compose() {
  if docker compose version &>/dev/null; then
    log_success "Docker Compose (plugin): $(docker compose version --short)"
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose &>/dev/null; then
    log_success "Docker Compose (standalone): $(docker-compose --version)"
    COMPOSE_CMD="docker-compose"
  else
    log_error "Docker Compose not found. Please install it."
    exit 1
  fi
}

# ── Detect Server IP ──
detect_ip() {
  SERVER_IP=$(curl -s -4 ifconfig.me 2>/dev/null || curl -s icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}')
  log_info "Server IP: $SERVER_IP"
}

# ── Clone / Update Project ──
setup_project() {
  if [ -d "$PROJECT_DIR/.git" ]; then
    log_info "Project directory exists. Pulling latest..."
    cd "$PROJECT_DIR"
    git pull --ff-only 2>/dev/null || true
  else
    # Remove leftover directory if it exists but isn't a git repo
    if [ -d "$PROJECT_DIR" ]; then
      log_warn "Removing incomplete project directory..."
      rm -rf "$PROJECT_DIR"
    fi

    log_info "Cloning deployment infrastructure (public repo)..."
    if ! git clone "$REPO_URL" "$PROJECT_DIR" 2>&1; then
      log_error "Failed to clone $REPO_URL"
      log_error "Make sure the install-hcos repository exists and is public."
      exit 1
    fi
    cd "$PROJECT_DIR"
  fi

  # Verify required files exist
  if [ ! -f "docker-compose.yml" ]; then
    log_error "docker-compose.yml not found in $PROJECT_DIR"
    log_error "The install-hcos repo must contain: docker-compose.yml, ONETIME/, nginx/, keycloak/"
    exit 1
  fi

  if [ ! -d "ONETIME" ]; then
    log_error "ONETIME/ directory not found in $PROJECT_DIR"
    log_error "The install-hcos repo must contain the ONETIME setup wizard."
    exit 1
  fi

  log_success "Project directory ready: $PROJECT_DIR"
}

# ── Build and Start ONETIME ──
start_setup() {
  log_info "Building ONETIME setup container (this may take 2-3 minutes)..."

  # Verify the onetime_setup service exists in docker-compose.yml
  if ! grep -q "onetime_setup" docker-compose.yml; then
    log_error "Service 'onetime_setup' not found in docker-compose.yml"
    log_error "Make sure docker-compose.yml contains the onetime_setup service with profile 'setup'."
    exit 1
  fi

  # Build
  if ! $COMPOSE_CMD --profile setup build onetime_setup 2>&1 | tail -10; then
    log_error "Docker build failed. Check the output above."
    exit 1
  fi

  # Start
  if ! $COMPOSE_CMD --profile setup up -d onetime_setup 2>&1; then
    log_error "Failed to start onetime_setup container."
    log_error "Run: docker logs onetime_setup"
    exit 1
  fi

  # Wait for the container to be ready
  log_info "Waiting for setup wizard to start..."
  for i in $(seq 1 30); do
    if curl -s "http://localhost:9090/api/health" &>/dev/null; then
      break
    fi
    sleep 2
  done
}

# ── Print Access URL ──
print_url() {
  echo ""
  echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  HCOS Setup Wizard is running!${NC}"
  echo ""
  echo -e "  ${CYAN}➜  http://${SERVER_IP}:9090${NC}"
  echo ""
  echo -e "  Open this URL in your browser to configure your deployment."
  echo -e "  Once you submit the form, all services will be deployed automatically."
  echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
  echo ""
}

# ══════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════

print_banner
detect_os
install_docker
check_compose
detect_ip
setup_project
start_setup
print_url
