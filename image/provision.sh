#!/usr/bin/env bash
# ori-image base provisioner.
# Idempotent, non-interactive. Runs as root on Ubuntu 24.04 (the only supported base).
# Shared by the Docker driver (P4-07) and the Incus VM image build (P12).
# Source of truth for what gets installed: image/manifest.md.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

ARCH="$(uname -m)"

apt_update_now() {
    apt-get update -q
}

log() { printf '\n>>> %s\n' "$*"; }

log "platform: $(uname -m), image: $(. /etc/os-release; echo "$PRETTY_NAME")"

# ---------------------------------------------------------------------------
# 1. First layer: everything apt needs to work + sudo (added here, not later)
# ---------------------------------------------------------------------------
log "installing base apt deps"
apt_update_now
apt-get install -y -q \
    ca-certificates \
    curl \
    gnupg \
    unzip \
    sudo

# ---------------------------------------------------------------------------
# 2. Extra apt sources (nodesource node 20, github cli, google chrome amd64)
# ---------------------------------------------------------------------------
# node via nodesource 20.x (stable, active-LTS line). version-agnostic on purpose:
# the 20.x repo line tracks the newest 20 LTS at build time.
log "adding nodesource node 20 repo"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -

# gh from the official GitHub CLI repo (latest stable release).
log "adding github cli repo"
install -m 0644 /dev/null /usr/share/keyrings/githubcli-archive-keyring.gpg
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
    gpg --dearmor --yes -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list

# google chrome-stable is amd64-only; the arm64 branch installs chromium instead
# (see manifest.md ponytail). Only add the Google repo on amd64.
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
    log "amd64: adding google chrome repo"
    install -m 0644 /dev/null /usr/share/keyrings/google-chrome.gpg
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /usr/share/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list
fi

apt_update_now

# ---------------------------------------------------------------------------
# 3. Install the pinned package list (see manifest.md)
# ---------------------------------------------------------------------------
PACKAGES=(
    openssh-server
    docker.io
    restic
    tmux
    git
    gh
    ripgrep
    jq
    ffmpeg
    build-essential
    cmake
    nodejs
    python3
    python3-pip
    python3-venv
    golang
    rustup
    sqlite3
    imagemagick
    # xterm stays as the never-fails fallback terminal: if the Budgie session ever fails
    # to come up, a desktop with xterm is debuggable and one without it looks dead.
    xterm
    x11-apps
)

log "installing apt packages: ${PACKAGES[*]}"
apt-get install -y -q "${PACKAGES[@]}"

# ---------------------------------------------------------------------------
# 3b. Desktop: Budgie
# ---------------------------------------------------------------------------
# The desktop stack, and what each piece is for:
#
#   lightdm  -> autologin user=user, user-session=budgie-desktop, timeout 0
#   Xorg     -> /etc/X11/xorg.conf.d/10-virtual-display.conf, Driver "dummy",
#               1920x1080 with an explicit CVT modeline
#   budgie-wm (mutter) + budgie-panel + budgie-daemon + budgie-session
#   nemo-desktop from ~/.config/autostart -> THIS is what draws the desktop icons.
#               Budgie has no desktop-icon layer of its own, and
#               org.nemo.desktop show-desktop-icons=true is what turns it on.
#   x11vnc -display :0 -forever -shared -localhost -noxdamage, then
#   websockify --web=/usr/share/novnc 6080 localhost:5900
#   Theme: Adwaita gtk/icon/cursor, Cantarell 11, wallpaper
#               /usr/share/backgrounds/gnome/adwaita-l.jpg
#
# The X server is the one compromise. A real Xorg on vt7 with the dummy driver is the
# richer option, but a container cannot do it -- Xorg wants a VT. Xvfb serves the same
# display :0 so every flag above ports over unchanged. What Xvfb costs us is RANDR
# resolution changes; the dummy driver is the upgrade path once oris run on VMs (P12
# Incus), and xserver-xorg-video-dummy plus the same conf are installed here ready for it.
DESKTOP_PACKAGES=(
    # Budgie itself. budgie-desktop pulls budgie-core, budgie-wm (mutter) and the panel.
    budgie-desktop
    budgie-control-center
    budgie-indicator-applet
    # nemo is "Files" on the desktop AND the desktop-icon renderer.
    nemo
    nemo-fileroller
    # "Terminal" and "Settings" on the desktop are these two, not Budgie's own.
    gnome-terminal
    gnome-control-center
    # The dock in the screenshot.
    plank
    # Session + login. lightdm autologins straight into Budgie with no greeter prompt.
    lightdm
    lightdm-gtk-greeter
    dbus-x11
    # Look and feel, so the desktop is not the grey fallback theme.
    adwaita-icon-theme
    gnome-themes-extra
    fonts-cantarell
    gnome-backgrounds
    # X server pieces: Xvfb serves now, the dummy driver is here for the VM path.
    xvfb
    xserver-xorg-video-dummy
    xserver-xorg-core
    x11-utils
    x11-xserver-utils
    # Streaming.
    x11vnc
    novnc
    websockify
    # Desktop automation. The image runs an xdotool-server.service, which is how `lux`
    # drives the GUI; these are the primitives it needs.
    xdotool
    wmctrl
    xsel
    xclip
)

log "installing the Budgie desktop: ${DESKTOP_PACKAGES[*]}"
DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${DESKTOP_PACKAGES[@]}"

# ---------------------------------------------------------------------------
# 3c. The polyglot toolchain and the terminal-graphics stack
# ---------------------------------------------------------------------------
# The apt sources this tier needs:
#   cran.list, docker.list, github-cli.list, google-chrome.sources,
#   microsoft-prod.list, nodesource.sources, ondrej-ubuntu-php-noble.sources, vscode.list
#
# ORI_IMAGE_TIER=core skips this whole section. `core` is ~3.5GB and builds in ~10
# minutes, `full` is several GB more and takes far longer -- and CI, e2e and my own
# iteration only ever need core. A build flag beats two divergent Dockerfiles.
TIER="${ORI_IMAGE_TIER:-full}"
log "image tier: $TIER"

if [ "$TIER" = "full" ]; then
    install -d -m 0755 /etc/apt/keyrings

    # VS Code + dotnet, both from Microsoft. amd64 only for code; dotnet has arm64.
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
        | gpg --dearmor -o /etc/apt/keyrings/packages.microsoft.gpg
    echo "deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" \
        > /etc/apt/sources.list.d/vscode.list
    echo "deb [signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main" \
        > /etc/apt/sources.list.d/microsoft-prod.list

    # R, from CRAN rather than the distro: the distro r-base lags badly.
    curl -fsSL https://cloud.r-project.org/bin/linux/ubuntu/marutter_pubkey.asc \
        | gpg --dearmor -o /etc/apt/keyrings/cran.gpg
    echo "deb [signed-by=/etc/apt/keyrings/cran.gpg] https://cloud.r-project.org/bin/linux/ubuntu noble-cran40/" \
        > /etc/apt/sources.list.d/cran.list

    apt_update_now

    TOOL_PACKAGES=(
        # --- terminal graphics. The reason a ori can show you an image over SSH. ---
        chafa                 # the good one: truecolor/sixel/kitty protocols
        caca-utils            # img2txt, cacaview
        jp2a                  # jpeg -> ascii
        libsixel-bin          # img2sixel. NOTE: the request said "libsisxel" -- typo.
        w3m w3m-img           # w3m -o inline_image, the classic terminal image viewer
        neofetch              # the system summary everyone screenshots
        toilet toilet-fonts figlet
        # --- android, per the intended tool list ---
        android-tools-adb android-tools-fastboot
        scrcpy
        # --- runtimes ---
        default-jdk maven gradle
        ruby-full
        php php-cli php-curl php-mbstring php-xml php-zip
        elixir erlang
        r-base r-base-dev
        # --- editors ---
        code
    )
    log "installing the full toolchain: ${TOOL_PACKAGES[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${TOOL_PACKAGES[@]}" || {
        # One unavailable package must not lose the whole layer -- `code` is amd64-only,
        # and elixir/erlang occasionally lag on arm64. Install what resolves, then report.
        log "bulk install failed; falling back to per-package so one gap does not sink the layer"
        for p in "${TOOL_PACKAGES[@]}"; do
            DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$p" \
                || log "SKIPPED (unavailable on $ARCH): $p"
        done
    }

    # dotnet: the metapackage name is version-bound, so try newest-first rather than pin.
    for v in 9.0 8.0; do
        if apt-get install -y -q "dotnet-sdk-$v" 2>/dev/null; then
            log "installed dotnet-sdk-$v"; break
        fi
    done

    # composer (php) and bundler (ruby) are not apt packages worth trusting; both have
    # first-party installers and both were present in this image.
    if command -v php >/dev/null 2>&1; then
        curl -fsSL https://getcomposer.org/installer -o /tmp/composer-setup.php \
            && php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer \
            && rm -f /tmp/composer-setup.php \
            || log "SKIPPED: composer"
    fi
    if command -v gem >/dev/null 2>&1; then
        gem install --no-document bundler || log "SKIPPED: bundler"
    fi

    # kotlin + scala/sbt ship as tarballs, not apt packages. Both were in this image.
    KOTLIN_VER=2.1.10
    curl -fsSL "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VER}/kotlin-compiler-${KOTLIN_VER}.zip" -o /tmp/kotlin.zip \
        && unzip -q /tmp/kotlin.zip -d /opt && rm -f /tmp/kotlin.zip \
        && ln -sf /opt/kotlinc/bin/kotlin /opt/kotlinc/bin/kotlinc /usr/local/bin/ \
        || log "SKIPPED: kotlin"

    SCALA_VER=3.6.3
    curl -fsSL "https://github.com/scala/scala3/releases/download/${SCALA_VER}/scala3-${SCALA_VER}.tar.gz" -o /tmp/scala.tgz \
        && tar -xzf /tmp/scala.tgz -C /opt && rm -f /tmp/scala.tgz \
        && ln -sf "/opt/scala3-${SCALA_VER}/bin/scala" "/opt/scala3-${SCALA_VER}/bin/scalac" /usr/local/bin/ \
        || log "SKIPPED: scala"

    curl -fsSL https://github.com/sbt/sbt/releases/download/v1.10.7/sbt-1.10.7.tgz -o /tmp/sbt.tgz \
        && tar -xzf /tmp/sbt.tgz -C /opt && rm -f /tmp/sbt.tgz \
        && ln -sf /opt/sbt/bin/sbt /usr/local/bin/sbt \
        || log "SKIPPED: sbt"

    # Ghostty. this image has it at /usr/bin/ghostty from a dpkg package literally named
    # `ghostty`, with no apt source configured -- so they install a .deb directly, and the only
    # .deb that exists is the community one from mkasberg/ghostty-ubuntu. Ghostty's own docs are
    # explicit that the project ships prebuilt binaries for macOS ONLY; every Linux binary is
    # community-maintained. Snap and AppImage are the alternatives and both are wrong here: snapd
    # barely works in a container, and AppImage wants FUSE.
    #
    # Assets are per-arch AND per-distro release (…_amd64_24.04.deb / …_arm64_24.04.deb), so both
    # architectures are covered -- this is not the amd64-only gap that Chrome is. Resolved from
    # the latest release rather than pinned, matching how gh and uv are installed above; a failure
    # to resolve degrades to SKIPPED rather than sinking the layer.
    GHOSTTY_ARCH=$([ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ] && echo arm64 || echo amd64)
    GHOSTTY_URL=$(curl -fsSL https://api.github.com/repos/mkasberg/ghostty-ubuntu/releases/latest \
        | grep -oE "https://[^\"]*_${GHOSTTY_ARCH}_24\.04\.deb" | head -1)
    if [ -n "${GHOSTTY_URL:-}" ]; then
        curl -fsSL "$GHOSTTY_URL" -o /tmp/ghostty.deb \
            && DEBIAN_FRONTEND=noninteractive apt-get install -y -q /tmp/ghostty.deb \
            && rm -f /tmp/ghostty.deb \
            && log "installed ghostty from $GHOSTTY_URL" \
            || log "SKIPPED: ghostty (.deb install failed)"
    else
        log "SKIPPED: ghostty (no ${GHOSTTY_ARCH} 24.04 asset in the latest release)"
    fi
fi


# google chrome / chromium, architecture-aware (manifest.md ponytail).
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    log "arm64: no google-chrome package -> installing snap-backed chromium"
    apt-get install -y -q chromium-browser
    ln -sf /usr/bin/chromium-browser /usr/local/bin/google-chrome-stable
else
    log "amd64: installing google-chrome-stable"
    apt-get install -y -q google-chrome-stable
fi

# ---------------------------------------------------------------------------
# 4. Toolchains/runtimes that come from their own installers (pinned at build)
# ---------------------------------------------------------------------------
# bun -> /usr/local/bin/bun (matches the whole stack being Bun, locked decision §2).
log "installing bun"
BUN_INSTALL=/usr/local bash -lc 'curl -fsSL https://bun.sh/install | bash >/dev/null'

# python tooling: venv already installed; ensure pip works + install uv.
log "installing uv via pip"
python3 -m pip install --no-cache-dir --break-system-packages -q uv

# ---------------------------------------------------------------------------
# 5. ori user: `user`, /home/user, passwordless sudo
# ---------------------------------------------------------------------------
log "creating ori user 'user'"
if ! id -u user >/dev/null 2>&1; then
    useradd -m -d /home/user -s /bin/bash -c "ori primary user" user
fi
id -u user >/dev/null
install -d -o user -g user /home/user
printf 'user ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/ori-user
# Also an `sudo`-group member, which is what a normal Ubuntu admin account looks like. sudo
# itself does not need it (the sudoers file above covers that), but polkit's DEFAULT admin
# identity is unix-group:sudo, and several desktop tools decide "is this user an admin" by
# group. Without it, Settings raises an authentication prompt the account cannot answer.
usermod -aG sudo user || true
chmod 0440 /etc/sudoers.d/ori-user

# ---------------------------------------------------------------------------
# 6. /etc/ori.env: ori-scoped env, sourced by login shells, systemd, sshd
# ---------------------------------------------------------------------------
# Owned by root, 0644; written by the guest agent on POST /env (P4-04).
install -m 0644 /dev/null /etc/ori.env
if [ ! -s /etc/ori.env ]; then
    printf 'ORI_PRIMARY_USER=user\nORI_HOME=/home/user\n' > /etc/ori.env
fi

# login (and interactive) shells: /etc/profile.d is pulled in by /etc/profile.
install -m 0644 /dev/null /etc/profile.d/ori-env.sh
cat > /etc/profile.d/ori-env.sh <<'EOF'
# shellcheck shell=bash
# source ori-scoped env for login/interactive shells
if [ -r /etc/ori.env ]; then
    set -a
    . /etc/ori.env
    set +a
fi
EOF

# non-interactive sshd command shells don't read profile.d; they read bash
# rc files. Source ori.env from /etc/bash.bashrc so `ssh user@host cmd` sees it.
if ! grep -qs 'ori.env' /etc/bash.bashrc; then
    cat >> /etc/bash.bashrc <<'EOF'

# ori-image: expose /etc/ori.env to non-interactive + non-login bash
if [ -r /etc/ori.env ]; then
    set -a
    . /etc/ori.env
    set +a
fi
EOF
fi

# systemd services: the guest-agent unit below uses EnvironmentFile=/etc/ori.env.

# ---------------------------------------------------------------------------
# 7. sshd hardening: no password, no root
# ---------------------------------------------------------------------------
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-ori-hardening.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin no
EOF

# Host keys are machine identity, so they must NOT be baked into the image: every
# ori (and every fork) would otherwise share one key, letting any ori impersonate
# any other to a client that already trusted it. Snapshots exclude machine identity
# for exactly this reason. So: generate now so build-time
# `sshd -t` passes, delete in cleanup, and regenerate per machine at first boot.
ssh-keygen -A || true

cat > /etc/systemd/system/ori-sshhostkeys.service <<'EOF'
[Unit]
Description=Generate this ori's own SSH host keys on first boot
Before=ssh.service
ConditionPathExists=!/etc/ssh/ssh_host_ed25519_key

[Service]
Type=oneshot
RemainAfterExit=yes
# ed25519 only, not `ssh-keygen -A`. Generating the RSA-3072 and ECDSA keys too was measured
# at 1.411s of every guest's boot, and nothing uses them: this repo's CLI authenticates with
# an ed25519 key, sshd is configured with no explicit HostKey directives, and every ssh
# client of the last decade negotiates ed25519. A ori that genuinely needs an RSA host key
# can run `ssh-keygen -A` itself.
ExecStart=/usr/bin/ssh-keygen -q -t ed25519 -N "" -f /etc/ssh/ssh_host_ed25519_key

[Install]
WantedBy=multi-user.target
EOF
systemctl enable ori-sshhostkeys.service || true

# ---------------------------------------------------------------------------
# 8. docker runs inside the ori
# ---------------------------------------------------------------------------
log "enabling docker (dockerd inside the ori)"
systemctl enable docker || true

# ---------------------------------------------------------------------------
# 9. desktop units (Xvfb, x11vnc, novnc) — installed, NOT enabled, lazy start
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/xvfb.service <<'EOF'
[Unit]
Description=Xvfb virtual framebuffer (ori desktop backend)
After=network.target
# Pull the whole Budgie session in with the display. Anything that starts the desktop
# chain (x11vnc or novnc, both of which Require xvfb) therefore gets a real desktop --
# panel, dock, desktop icons -- rather than a bare X root with undecorated windows.
Wants=budgie-session.service

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/budgie-session.service <<'EOF'
[Unit]
Description=Budgie desktop session on the ori display
Requires=xvfb.service
After=xvfb.service

[Service]
User=user
PAMName=login
# dbus-run-session is the load-bearing part. Budgie is GNOME-based: budgie-panel,
# budgie-daemon, the settings daemons, nemo-desktop and the xdg portals all talk over a
# SESSION bus, and without one the session half-starts -- a compositor with no panel and
# no desktop icons, which looks like a broken desktop rather than a missing bus.
#
# The session gets its bus from lightdm autologin (user-session=budgie-desktop). A
# container cannot use lightdm: it drives a real Xorg on a VT and there is no VT here.
# This unit is the container equivalent of that autologin.
Environment=DISPLAY=:99
# XDG_RUNTIME_DIR is load-bearing and its absence is silent. Without it the unit reports
# "active", budgie-desktop starts, and then NOTHING comes up -- no panel, no window manager,
# no desktop icons -- because every GNOME-lineage component puts its sockets and state under
# it and gives up quietly when it is unset. Confirmed by running budgie-desktop by hand with
# and without it: with, budgie-panel and nemo-desktop appear; without, an empty display.
# %U expands to the uid of User= above, so this does not hardcode 1000 vs 1001.
Environment=XDG_RUNTIME_DIR=/run/user/%U
Environment=XDG_CURRENT_DESKTOP=Budgie:GNOME
Environment=XDG_SESSION_TYPE=x11
Environment=GDK_BACKEND=x11
Environment=NO_AT_BRIDGE=1
# Software rendering: there is no GPU in a ori, and mutter (which budgie-wm wraps) will
# refuse to start rather than fall back on its own.
Environment=LIBGL_ALWAYS_SOFTWARE=1
Environment=GALLIUM_DRIVER=llvmpipe
# logind normally creates /run/user/<uid>; in a container it may not, so make it ourselves.
#
# The `+` prefix is the load-bearing character. User=user above applies to ExecStartPre too, and
# an unprivileged process cannot chown -- not even to its own name; that is root-only. Without
# the `+` the chown exits 1, systemd treats a failed control process as a failed unit, and the
# session never starts: a black screen with a working mouse cursor and nothing else.
#
# `+` runs the command as root regardless of User=, which is exactly what it exists for.
#
# Worth recording how this was missed: the fix was verified by creating /run/user/<uid> by hand
# as root inside a container and then restarting the unit -- so the unit never had to create it,
# and the test proved a state that had been prepared for it.
ExecStartPre=+/bin/mkdir -p /run/user/%U
ExecStartPre=+/bin/chown %u:%u /run/user/%U
ExecStartPre=+/bin/chmod 700 /run/user/%U
ExecStartPre=/bin/bash -c 'for i in $(seq 1 30); do DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && exit 0; sleep 1; done; echo "X not ready" >&2; exit 1'
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/budgie-desktop
# D-Bus-activated children (nemo-desktop among them) escape this unit's cgroup, so a plain
# restart can leave one behind -- and two nemo-desktops paint two overlapping sets of desktop
# icons, which looks like a rendering bug rather than a stray process.
ExecStopPost=-/usr/bin/pkill -u %u -x nemo-desktop
ExecStartPre=-/usr/bin/pkill -u %u -x nemo-desktop
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF


# ---------------------------------------------------------------------------
# 9b. Desktop look, launchers and desktop icons
# ---------------------------------------------------------------------------
# All of this is deliberate rather than incidental.
#
# Desktop icons are the non-obvious part: Budgie draws none. in this image
# ~/.config/autostart/nemo-desktop.desktop starts nemo-desktop, and
# `org.nemo.desktop show-desktop-icons=true` is what makes it paint them. Without both,
# the wallpaper appears and the icons simply never do.
log "desktop: theme defaults, launchers, desktop icons"

# dconf defaults rather than a `gsettings set` at build time: gsettings writes into a
# user's dconf database, and at build time there is no user session to write into. A
# system default applies to every ori and still lets the user change it.
install -d -m 0755 /etc/dconf/profile /etc/dconf/db/local.d
printf 'user-db:user\nsystem-db:local\n' > /etc/dconf/profile/user
cat > /etc/dconf/db/local.d/00-ori-desktop <<'EOF'
[org/gnome/desktop/background]
picture-uri='file:///usr/share/backgrounds/gnome/adwaita-l.jpg'
picture-uri-dark='file:///usr/share/backgrounds/gnome/adwaita-d.jpg'
picture-options='zoom'
primary-color='#023c88'

[org/gnome/desktop/interface]
gtk-theme='Adwaita'
icon-theme='Adwaita'
cursor-theme='Adwaita'
font-name='Cantarell 11'
monospace-font-name='Monospace 11'

[org/nemo/desktop]
show-desktop-icons=true

[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/screensaver]
lock-enabled=false
idle-activation-enabled=false
EOF
dconf update || true

# The six launchers this image puts on the desktop. Copied from the installed
# .desktop files rather than hand-written, so they carry the right Exec, Icon and
# StartupWMClass -- a hand-written Exec is how you get an icon that does nothing.
# /etc/skel so every future user gets them; ~user because that home already exists.
for target in /etc/skel /home/user; do
    install -d -m 0755 "$target/Desktop"
    for src in \
        /usr/share/applications/nemo.desktop \
        /usr/share/applications/org.gnome.Terminal.desktop \
        /usr/share/applications/org.gnome.Settings.desktop \
        /usr/share/applications/google-chrome.desktop \
        /usr/share/applications/code.desktop \
        /usr/share/applications/com.mitchellh.ghostty.desktop
    do
        [ -f "$src" ] && install -m 0755 "$src" "$target/Desktop/" || true
    done
    # chromium stands in for chrome on arm64, where Google ships no package.
    if [ ! -f "$target/Desktop/google-chrome.desktop" ]; then
        for alt in /usr/share/applications/chromium*.desktop; do
            [ -f "$alt" ] && install -m 0755 "$alt" "$target/Desktop/" && break
        done
    fi

    # nemo-desktop via XDG autostart, deliberately. budgie-session
    # honours ~/.config/autostart, so this is what brings the icons up with the session.
    install -d -m 0755 "$target/.config/autostart"
    cat > "$target/.config/autostart/nemo-desktop.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Desktop icons (nemo)
Exec=nemo-desktop
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
done
chown -R user:user /home/user/Desktop /home/user/.config 2>/dev/null || true

# The default wallpaper.
#
# Setting it via dconf alone does NOT work, which was measured rather than assumed: the
# ubuntu-budgie desktop ships its own default (Northan_lights_by_mizuno.webp) that ends up in the
# user's own dconf, and a user value outranks a system default. So the wallpaper is applied inside
# the session, where nothing outranks it, by an autostart entry.
#
# Three keys, not one: the light and dark variants so it does not change with the theme, and the
# screensaver so a lock screen matches.
log "installing the default wallpaper"
install -d -m 0755 /usr/share/backgrounds/ori
if [ -f /opt/ori/branding/ori-wallpaper.png ]; then
    install -m 0644 /opt/ori/branding/ori-wallpaper.png /usr/share/backgrounds/ori/ori-wallpaper.png
else
    log "SKIPPED: wallpaper asset missing from the build context"
fi

install -d -m 0755 /usr/local/bin
cat > /usr/local/bin/ori-set-wallpaper <<'EOF'
#!/usr/bin/env bash
# Apply the ori wallpaper. Runs once per session from XDG autostart, inside the session bus,
# because that is the only place a value outranks the distribution's own default.
#
# Not forced on every login: if the user picks their own wallpaper we must not stamp over it. The
# marker file records that the default has been applied once.
set -u
WALL=/usr/share/backgrounds/ori/ori-wallpaper.png
MARKER="${XDG_CONFIG_HOME:-$HOME/.config}/ori/wallpaper-applied"
[ -f "$WALL" ] || exit 0
[ -f "$MARKER" ] && exit 0

URI="file://$WALL"
gsettings set org.gnome.desktop.background picture-uri "$URI"       2>/dev/null || true
gsettings set org.gnome.desktop.background picture-uri-dark "$URI"  2>/dev/null || true
gsettings set org.gnome.desktop.background picture-options "centered" 2>/dev/null || true
gsettings set org.gnome.desktop.background primary-color "#000000"  2>/dev/null || true
gsettings set org.gnome.desktop.screensaver picture-uri "$URI"      2>/dev/null || true
# nemo-desktop draws the desktop here, and Cinnamon's schema is what it reads when present.
gsettings set org.cinnamon.desktop.background picture-uri "$URI"    2>/dev/null || true
gsettings set org.cinnamon.desktop.background picture-options "centered" 2>/dev/null || true

mkdir -p "$(dirname "$MARKER")" && : > "$MARKER"
EOF
chmod 0755 /usr/local/bin/ori-set-wallpaper

for target in /etc/skel /home/user; do
    install -d -m 0755 "$target/.config/autostart"
    cat > "$target/.config/autostart/ori-wallpaper.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=ori wallpaper
Exec=/usr/local/bin/ori-set-wallpaper
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Phase=Applications
NoDisplay=true
EOF
done
chown -R user:user /home/user/.config 2>/dev/null || true

# `host` — expose a port from inside the ori. Without this the guest agent's /host endpoints
# (packages/guest-agent/src/host.ts) are unreachable from a shell in the box: they need the
# agent bearer token, and /etc/ori-agent.env is root-only. Passwordless sudo already makes the
# login user root here, so reading it is a formality, not a privilege gain.
cat > /usr/local/bin/host <<'EOF'
#!/usr/bin/env bash
# usage: host <port> [--public] | host list | host url <port> | host hide <port>
set -euo pipefail
TOKEN=$(sudo -n sed -n 's/^ORI_AGENT_TOKEN=//p' /etc/ori-agent.env 2>/dev/null || true)
if [ -z "$TOKEN" ]; then
    echo "host: no agent identity in this machine (/etc/ori-agent.env) -- hosting is unavailable" >&2
    exit 1
fi
agent() { curl -fsS -H "authorization: Bearer $TOKEN" "$@"; }
case "${1:-}" in
    list) agent http://127.0.0.1:7777/host | jq -r '.routes[] | "\(.port)\t\(.url)\t\(.access)"' ;;
    url)  agent "http://127.0.0.1:7777/host/url?port=${2:?usage: host url <port>}" | jq -r '.url' ;;
    hide) agent -X DELETE "http://127.0.0.1:7777/host?port=${2:?usage: host hide <port>}" >/dev/null ;;
    ''|-h|--help) sed -n '2s/^# //p' "$0" ;;
    *)
        port=$1
        public=false
        [ "${2:-}" = "--public" ] && public=true
        agent -X POST -H 'content-type: application/json' \
            -d "{\"port\":${port},\"public\":${public}}" http://127.0.0.1:7777/host \
            | jq -r 'if .token then "\(.url)?_token=\(.token)" else .url end'
        ;;
esac
EOF
chmod 0755 /usr/local/bin/host

# The dummy-driver Xorg config for the VM path, installed but unused: Xvfb serves the
# display in a container. This is here so the P12 Incus/VM path is a one-line switch
# rather than a rediscovery -- and it is where RANDR resolution changes come from.
install -d -m 0755 /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/10-virtual-display.conf <<'EOF'
Section "Device"
    Identifier  "Configured Video Device"
    Driver      "dummy"
    VideoRam    256000
EndSection

Section "Monitor"
    Identifier  "Configured Monitor"
    HorizSync   30.0-90.0
    VertRefresh 50.0-75.0
    Modeline "1920x1080_60.00"  173.00  1920 2048 2248 2576  1080 1083 1088 1120 -hsync +vsync
EndSection

Section "Screen"
    Identifier  "Default Screen"
    Monitor     "Configured Monitor"
    Device      "Configured Video Device"
    DefaultDepth 24
    SubSection "Display"
        Depth 24
        Modes "1920x1080_60.00"
        Virtual 1920 1080
    EndSubSection
EndSection
EOF

# ---------------------------------------------------------------------------
# 9b-2. No password prompts, anywhere
# ---------------------------------------------------------------------------
# `user` has NO password, deliberately: sshd refuses password auth, so there is nothing for a
# password to protect and nothing to leak. But polkit does not know that. Open Settings, try to
# change anything privileged, and Budgie raises "Authentication required" — an unanswerable
# dialog, because the account has no password to type.
#
# Passwordless sudo covers the shell only; polkit is a separate authority. So tell polkit
# directly that members of `sudo` need no authentication. This is the correct fix for a
# single-occupant sandbox: the alternatives are worse. Setting a known password would put a
# credential in the image; running the desktop as root breaks GNOME components and puts
# root-owned files back in the user's home, which is the bug that started this whole thread.
log "polkit: no authentication prompts for the sandbox user"
install -d -m 0755 /etc/polkit-1/rules.d
cat > /etc/polkit-1/rules.d/49-ori-nopasswd.rules <<'EOF'
// Administrators are `user` and the sudo group. Named BOTH on purpose: sudo here is granted by
// /etc/sudoers.d/ori-user rather than by group, so a rule keyed only on unix-group:sudo matched
// nothing and every prompt still appeared. Checked, not assumed -- `id -nG user` printed just
// `user`.
polkit.addAdminRule(function (action, subject) {
    return ["unix-user:user", "unix-group:sudo"];
});

polkit.addRule(function (action, subject) {
    if (subject.user === "user" || subject.isInGroup("sudo")) {
        return polkit.Result.YES;
    }
});
EOF
chmod 0644 /etc/polkit-1/rules.d/49-ori-nopasswd.rules

# lightdm ships enabled and would fight for the display in a container that has no VT.
# The Budgie session is started by budgie-session.service instead.
systemctl disable lightdm.service 2>/dev/null || true
systemctl mask lightdm.service 2>/dev/null || true


# ---------------------------------------------------------------------------
# 9c. Mask the units a container can never run
# ---------------------------------------------------------------------------
# Installing a desktop drags in a pile of services that enable themselves and then fail,
# because the hardware or kernel interface they want is not there: ModemManager wants a
# modem, udisks2 wants real block devices, colord wants a colorimeter, cups wants a
# printer. Two consequences, both of which we hit:
#
#   1. systemd settles at "degraded" instead of "running" -- permanently and correctly.
#      Any readiness check that insists on "running" waits forever.
#   2. Boot takes far longer, because systemd starts, waits on, and times out each one.
#      A ori that used to reach `ready` in ~3 seconds took over 90.
#
# Masking is stronger than disabling on purpose: a dependency of another unit can pull a
# merely-disabled unit back in, and several of these are wanted by the desktop session.
log "masking units that cannot work inside a container"
CONTAINER_HOSTILE=(
    # hardware daemons with no hardware
    tpm-udev.service
    tpm-udev.path
    ModemManager.service
    wpa_supplicant.service
    bluetooth.service
    udisks2.service
    upower.service
    colord.service
    switcheroo-control.service
    power-profiles-daemon.service
    thermald.service
    fwupd.service
    fwupd-refresh.service
    # printing: nothing in a ori prints
    cups.service
    cups-browsed.service
    cups.path
    cups.socket
    # storage stacks a container does not own
    multipathd.service
    multipathd.socket
    iscsid.service
    open-iscsi.service
    lvm2-monitor.service
    e2scrub_all.service
    e2scrub_reap.service
    # host-level concerns; the ori is disposable and the control plane owns its lifecycle
    snapd.service
    snapd.socket
    snapd.seeded.service
    unattended-upgrades.service
    apt-daily.timer
    apt-daily-upgrade.timer
    apport.service
    packagekit.service
    # NetworkManager would fight docker for the container's interface
    NetworkManager.service
    NetworkManager-wait-online.service
    avahi-daemon.service
    avahi-daemon.socket
    # systemd-timesyncd cannot set the clock in a container; the host owns it
    systemd-timesyncd.service
    # gnome-remote-desktop duplicates what x11vnc already does here
    gnome-remote-desktop.service
    # ldconfig.service: 957ms, and measured ON the critical path to ori-agent.service
    # (systemd-analyze critical-chain: ldconfig -> local-fs -> sysinit -> basic -> ori-seed
    # -> ori-agent). The linker cache is already correct in a prebuilt image, and dpkg runs
    # ldconfig itself via triggers when a ori installs packages, so nothing needs it at boot.
    ldconfig.service
    # apache2 arrives as a dependency of the php metapackage and boots a web server in every
    # sandbox nobody asked for (666ms). Installed and startable, just not at boot.
    apache2.service
    apache2-htcacheclean.service
    phpsessionclean.service
    phpsessionclean.timer
    # AccountsService exists for desktop login screens; lightdm is already masked above
    accounts-daemon.service
)
for u in "${CONTAINER_HOSTILE[@]}"; do
    systemctl mask "$u" 2>/dev/null || true
done

# A ori should not be waiting on the network being "up" either: docker has already wired
# the interface by the time systemd runs.
systemctl disable systemd-networkd-wait-online.service 2>/dev/null || true
systemctl mask systemd-networkd-wait-online.service 2>/dev/null || true

# ---------------------------------------------------------------------------
# 9c. DNS for the firecracker guest
# ---------------------------------------------------------------------------
# The firecracker driver boots the guest with a STATIC ip= kernel arg and no DHCP, and the
# mainline kernel does not populate /etc/resolv.conf from that (no initramfs, and Ubuntu's
# systemd does not read /proc/net/pnp). The result was a 0-byte /etc/resolv.conf in every FC
# box: raw IP routing worked, but `getent hosts github.com` failed, so apt, git clone, npm
# install and `docker pull` were all broken. Docker-driver boxes never hit this because
# dockerd writes the container's resolv.conf itself.
#
# So bake a resolver in. ORI_DNS is overridable at build time; the default is a public pair.
# Harmless on the docker driver, where dockerd's bind-mounted resolv.conf shadows this file.
# A plain file, not a systemd-resolved symlink: the FC guest does not run resolved, and a
# dangling stub symlink is exactly the 0-byte-effective state we are fixing.
log "writing a static /etc/resolv.conf (firecracker guests get no DNS otherwise)"
rm -f /etc/resolv.conf
{
    for ns in ${ORI_DNS:-1.1.1.1 8.8.8.8}; do echo "nameserver $ns"; done
    echo "options edns0 trust-ad"
} > /etc/resolv.conf
chmod 0644 /etc/resolv.conf
# systemd-resolved would clobber the static file with its stub on boot; the guest resolves
# directly, so keep it out of the way (idempotent, and a no-op if it is not installed).
systemctl disable systemd-resolved.service 2>/dev/null || true
systemctl mask systemd-resolved.service 2>/dev/null || true

# ---------------------------------------------------------------------------
# 9d. Stop masked units from costing 25 seconds each
# ---------------------------------------------------------------------------
# Masking a unit is only half the job, and the missing half is expensive.
#
# D-Bus keeps its own activation files in /usr/share/dbus-1/system-services/. When a client
# asks for, say, org.freedesktop.ModemManager1, dbus asks systemd to start the unit named in
# that file. systemd refuses because it is masked -- and dbus then waits out its FULL
# activation timeout, service_start_timeout=25000ms, before returning an error.
#
# So masking made the desktop dramatically slower rather than faster. Measured: Settings
# (gnome-control-center, whose WWAN panel asks for ModemManager) took 25592ms to open a
# window. With the activation file gone so the lookup fails immediately: 285ms. Every app
# that touches a masked service paid that toll, not just Settings.
#
# Derived rather than hardcoded: read each activation file's SystemdService= and remove the
# file only if that unit is actually masked. Add a unit to the list above and this follows.
# Moved aside rather than deleted, so it is reversible and auditable.
log "removing D-Bus activation for masked units (each one otherwise costs a 25s timeout)"
install -d -m 0755 /opt/ori/disabled-dbus-services
for f in /usr/share/dbus-1/system-services/*.service; do
    [ -f "$f" ] || continue
    unit=$(sed -n 's/^SystemdService=[[:space:]]*//p' "$f" | head -1)
    [ -n "$unit" ] || continue
    if [ "$(systemctl is-enabled "$unit" 2>/dev/null)" = "masked" ]; then
        mv "$f" /opt/ori/disabled-dbus-services/ && log "  dbus activation removed: $(basename "$f") -> $unit"
    fi
done

cat > /etc/systemd/system/x11vnc.service <<'EOF'
[Unit]
Description=x11vnc VNC server into the Xvfb display
Requires=xvfb.service
After=xvfb.service

[Service]
ExecStart=/usr/bin/x11vnc -display :99 -forever -shared -nopw -listen 127.0.0.1 -rfbport 5900
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/novnc.service <<'EOF'
[Unit]
Description=noVNC browser client proxying to x11vnc (websockify)
Requires=x11vnc.service
After=x11vnc.service

[Service]
# websockify forwards HTTPS/WSS to the local VNC port; control plane proxies it.
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 6080 localhost:5900
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# deliberately NOT enabled: desktop starts lazily on P8 /controllers request.

# ---------------------------------------------------------------------------
# 10. guest agent drop point
# ---------------------------------------------------------------------------
# Placeholder only. The real binary (/opt/ori/guest-agent/ori-agent) is injected
# by the docker driver (P4-07) / incus image build (P12).
install -d -m 0755 /opt/ori/guest-agent
printf 'placeholder - real binary injected by P4-07 docker driver / P12 incus build\n' \
    > /opt/ori/guest-agent/README.txt

# Enabled IN THE IMAGE (no-op without the binary, thanks to ConditionPathExists). A driver
# that finds the unit disabled — any image built before this change — falls back to waiting for
# systemd to finish booting and then `enable --now`-ing the unit, two execs and a boot poll per
# create. Enabled here, the agent starts during boot, in parallel with the rest of the machine,
# and create() only has to wait for /health.
#
# EnvironmentFile=-/etc/ori-agent.env is the per-ori identity the driver mounts in
# (ORI_ID / ORI_AGENT_TOKEN / ORI_WORK_DIR). The leading dash makes the file OPTIONAL, so a
# bare container of the base image (no driver mount) still boots; /etc/ori.env holds the
# shared user env. systemd's own `-e` container env never reaches units, which is why the
# identity travels in a file rather than docker -e flags.
cat > /etc/systemd/system/ori-agent.service <<'EOF'
[Unit]
Description=ori guest agent (:7777)
ConditionPathExists=/opt/ori/guest-agent/ori-agent

[Service]
ExecStart=/opt/ori/guest-agent/ori-agent
EnvironmentFile=/etc/ori.env
EnvironmentFile=-/etc/ori-agent.env
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
# The WantedBy symlink `systemctl enable` would create, created directly. `systemctl enable`
# needs a running manager to talk to and fails inside an image build; swallowing that failure
# with `|| true` would silently ship an image where every create falls back to the slow path.
install -d -m 0755 /etc/systemd/system/multi-user.target.wants
ln -sf /etc/systemd/system/ori-agent.service \
    /etc/systemd/system/multi-user.target.wants/ori-agent.service

# ---------------------------------------------------------------------------
# 11. cleanup: shrink the image, drop apt lists
# ---------------------------------------------------------------------------
log "cleaning apt"
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf /home/user/.cache

# Strip machine identity. ori-sshhostkeys.service regenerates per ori before sshd
# starts, so a bare `docker exec ... sshd -t` on a freshly built image will fail
# with "no hostkeys available" -- that is correct, not a build error. Check sshd
# config with `sshd -t -f` after the unit has run, or inside a booted container.
rm -f /etc/ssh/ssh_host_*
: > /etc/machine-id

# ---------------------------------------------------------------------------
# 12. base-image /etc baseline — the snapshot sysdiff diffs against this
# ---------------------------------------------------------------------------
# a snapshot must capture what the USER changed in /etc (packages,
# units, config, crontabs) without backing up /etc wholesale. The guest agent
# diffs the live /etc against THIS manifest — recorded here, at build time, in
# the pristine image state AFTER identity stripping — and stores only the delta.
# It lives in the image so a ori computes the diff with no control-plane round
# trip. Machine identity (/etc/machine-id, ssh host keys, hostname) is absent
# from it by construction; the guest also excludes those paths defensively.
log "recording /etc baseline for snapshot sysdiff"
python3 - <<'PYEOF'
import hashlib, json, os

root = "/etc"
files = {}
symlinks = {}
dirs = []
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    dirs.append(dirpath)
    for name in filenames:
        p = os.path.join(dirpath, name)
        try:
            if os.path.islink(p):
                symlinks[p] = os.readlink(p)
            else:
                files[p] = {"sha256": hashlib.sha256(open(p, "rb").read()).hexdigest()}
        except OSError:
            pass

manifest = {"version": 1, "files": files, "symlinks": symlinks, "dirs": sorted(dirs)}
os.makedirs("/opt/ori/ori-image", exist_ok=True)
with open("/opt/ori/ori-image/etc-manifest.json", "w") as f:
    json.dump(manifest, f, sort_keys=True)
PYEOF

log "provision complete"