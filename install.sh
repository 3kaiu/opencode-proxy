#!/bin/sh
# install.sh - Install or update oc (opencode proxy switcher)
# Usage: curl -fsSL https://github.com/3kaiu/opencode-proxy/raw/main/install.sh | sh
#
# This script downloads the latest release from GitHub and installs it to ~/bin/oc

set -e

REPO="3kaiu/opencode-proxy"
BINARY_NAME="oc"
INSTALL_DIR="${HOME}/bin"
INSTALL_PATH="${INSTALL_DIR}/${BINARY_NAME}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() {
    printf "${GREEN}✓${NC} %s\n" "$1"
}

warn() {
    printf "${YELLOW}⚠${NC} %s\n" "$1"
}

error() {
    printf "${RED}✗${NC} %s\n" "$1" >&2
    exit 1
}

# Detect OS
detect_os() {
    OS="$(uname -s)"
    case "$OS" in
        Linux*)  echo "linux" ;;
        Darwin*) echo "darwin" ;;
        *)       error "Unsupported operating system: $OS" ;;
    esac
}

# Detect architecture
detect_arch() {
    ARCH="$(uname -m)"
    case "$ARCH" in
        x86_64|amd64)   echo "amd64" ;;
        arm64|aarch64)  echo "arm64" ;;
        *)              error "Unsupported architecture: $ARCH" ;;
    esac
}

# Get latest release version
get_latest_version() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/'
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/'
    else
        error "Neither curl nor wget found. Please install one of them."
    fi
}

# Download binary
download_binary() {
    local os="$1"
    local arch="$2"
    local asset_name="${BINARY_NAME}-${os}-${arch}"
    local download_url="https://github.com/${REPO}/releases/latest/download/${asset_name}"

    info "Downloading ${asset_name}..."

    # Create temp file
    local tmp_file
    tmp_file="$(mktemp)"

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$download_url" -o "$tmp_file" || error "Failed to download from $download_url"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "$download_url" -O "$tmp_file" || error "Failed to download from $download_url"
    fi

    echo "$tmp_file"
}

# Install binary
install_binary() {
    local src="$1"

    # Create install directory if needed
    if [ ! -d "$INSTALL_DIR" ]; then
        mkdir -p "$INSTALL_DIR"
        info "Created directory: $INSTALL_DIR"
    fi

    # Backup existing binary if present
    if [ -f "$INSTALL_PATH" ]; then
        local backup="${INSTALL_PATH}.bak"
        mv "$INSTALL_PATH" "$backup"
        info "Backed up existing binary to ${backup}"
    fi

    # Install new binary
    mv "$src" "$INSTALL_PATH"
    chmod +x "$INSTALL_PATH"
    info "Installed to $INSTALL_PATH"
}

# Check if ~/bin is in PATH
check_path() {
    case ":$PATH:" in
        *":${INSTALL_DIR}:"*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Suggest PATH setup
suggest_path_setup() {
    local shell_name
    shell_name="$(basename "$SHELL")"

    case "$shell_name" in
        bash)
            echo ""
            echo "Add this to your ~/.bashrc:"
            echo "  export PATH=\"\$HOME/bin:\$PATH\""
            ;;
        zsh)
            echo ""
            echo "Add this to your ~/.zshrc:"
            echo "  export PATH=\"\$HOME/bin:\$PATH\""
            ;;
        fish)
            echo ""
            echo "Run this command:"
            echo "  fish_add_path ~/bin"
            ;;
        *)
            echo ""
            echo "Add ~/bin to your PATH"
            ;;
    esac
}

# Main
main() {
    echo ""
    echo "Installing oc (opencode proxy switcher)..."
    echo ""

# Detect platform
    local os arch
    os="$(detect_os)"
    arch="$(detect_arch)"
    info "Detected platform: ${os}-${arch}"

    # 目前仅发布 macOS arm64 预编译产物；其他平台提示本地编译
    if [ "$os" != "darwin" ] || [ "$arch" != "arm64" ]; then
        error "未发布 ${os}-${arch} 预编译产物。本地编译: npm install -g scriptc && scriptc build cli/oc.ts -o $HOME/bin/oc"
    fi

    # Download
    local tmp_file
    tmp_file="$(download_binary "$os" "$arch")"

    # Install
    install_binary "$tmp_file"

    # Verify installation
    if [ -x "$INSTALL_PATH" ]; then
        echo ""
        info "Installation complete!"
        echo ""
        echo "Run 'oc help' to get started."
        echo ""

        # Check PATH
        if ! check_path; then
            warn "~/bin is not in your PATH"
            suggest_path_setup
            echo ""
        fi
    else
        error "Installation failed"
    fi
}

main "$@"
