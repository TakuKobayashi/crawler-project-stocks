# generate-ai-stocks

[日本語版はこちら / Japanese README](./README.ja.md)

generate-ai-stocks is an integrated repository designed to transform ideas that would otherwise be buried by time constraints into working implementations using generative AI first, then refine, integrate, and launch them as reusable development assets.

---

## Purpose

- Prevent ideas from stopping at the concept stage
- Maximize implementation speed
- Prioritize getting ideas into a working state first
- Accumulate projects as reusable, integratable assets
- Launch promising projects independently

---

## Core Philosophy

### 1. Build working implementations first

Instead of spending excessive time building everything manually from scratch, generative AI is used to rapidly create functional first versions.

### 2. Refine after functionality exists

Once something works:

- Improvements become clearer
- Integration becomes easier
- Explanation to others becomes easier
- Launch decisions become easier

### 3. Even samples become assets

Technical experiments, prototypes, and samples are also valuable when they function properly, because they reduce future:

- Development time
- Integration cost
- Explanation cost
- Reuse barriers

---

## Project Categories

### Product Candidate

Launch / SaaS / monetization candidates

### Utility / Automation

CLI / GitHub Actions / operational tooling

### Technical Asset

Samples / infrastructure experiments / reusable technical foundations

---

## Development Phases

- incubating → Idea becoming real
- validating → Improving and operational tuning
- launched → Public / independently operational
- archived → Maintenance stopped / retained as technical asset

---

## Projects

| Project                                                          | Description | status     |
| ---------------------------------------------------------------- | ----------- | ---------- |
| [GovernmentOpenDataWebAPI](./projects/GovernmentOpenDataWebAPI/) |             | incubating |
| [hackathon_portal](./projects/hackathon_portal/)                 |             | incubating |
| [residence-crawler](./projects/residence-crawler/)               |             | incubating |
| [resource-crawler](./projects/resource-crawler/)                 |             | incubating |

---

## Development Workflow

### Add new project

```bash
npm run projects:add -- --name my-new-project --description "Project description"
```

### Sync portfolio + README

```bash
npm run projects:sync
```

### Validate project.yml

```bash
npm run projects:validate
```

## VPN connection

The VPN command selects a VPN Gate server and launches the OpenVPN Community `openvpn` executable installed on the host.
OpenVPN is a native program that manages OS tunnel devices, routes, and DNS, so installing an npm package cannot safely
install the executable and grant the required OS permissions. Install it once for each operating system:

### macOS

```bash
brew install openvpn
openvpn --version
```

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install openvpn
openvpn --version
```

### Fedora

```bash
sudo dnf install openvpn
openvpn --version
```

### Arch Linux

```bash
sudo pacman -S openvpn
openvpn --version
```

### Windows 10 or later

Install the Community MSI from the [official OpenVPN Community downloads](https://openvpn.net/community-downloads/).
Enable the option that adds OpenVPN to PATH, open a new PowerShell window, and verify the installation:

```powershell
openvpn --version
```

If it is not on PATH, add the usual installation directory, `C:\Program Files\OpenVPN\bin`, to the user or system PATH.

### Connect

Changing network routes may require administrator privileges. If a normal command fails with a permission error, use
`sudo pnpm vpn:connect` on macOS/Linux or an elevated PowerShell window on Windows.

```bash
pnpm vpn:connect
pnpm vpn:status
pnpm vpn:disconnect
```

Connection filters are optional:

```bash
pnpm vpn:connect --country JP --max-ping 100 --min-speed 10
```

### Why not Docker?

OpenVPN can run in Docker, but it requires the `NET_ADMIN` capability and a TUN device. Its VPN route normally applies
only to that container's network namespace, not to this host CLI or every crawler. Docker becomes appropriate only when
the crawlers also run inside the VPN container's network namespace, so this repository currently uses a host installation.

---

## Submodule Workflow (Post-launch)

### Initial clone

```bash
git clone --recurse-submodules <repo-url>
```

### Pull latest parent + all submodules

```bash
npm run projects:pull
```

### Push all development updates

```bash
npm run projects:push
```

### Check status

```bash
npm run projects:status
```

---

## Submodule Notes

- Continue development inside generate-ai-stocks as before
- Launch-ready projects can become independent repositories
- Same environment reproducible across multiple PCs
- Parent repo functions as central command hub

---

## Operational Strategy

### Phase1:

Idea → Generate → Working Implementation

### Phase2:

Refine / Integrate

### Phase3:

Launch / Spin-out

---

## Repository Lifecycle

Projects in this repository typically follow this lifecycle:

1. Create a new project under `projects/`
2. Develop and validate the idea
3. Publish it as an independent repository when it becomes mature
4. Reconnect it as a Git Submodule
5. Continue managing it from this repository

This approach allows centralized discovery while keeping each project independent.

### Converting a Project into an Independent Repository

Create a new repository and push the project:

    cd projects/my-project

    git init
    git add .
    git commit -m "Initial commit"

    git branch -M main

    git remote add origin https://github.com/<user>/my-project.git

    git push -u origin main

Remove the local directory from the parent repository:

    git rm -r projects/my-project

    git commit -m "Remove local project"

Add it back as a Git Submodule:

    git submodule add https://github.com/<user>/my-project.git projects/my-project

    git commit -m "Add submodule"

### Clone Repository with Submodules

    git clone --recursive <repository-url>

### Initialize Submodules After Clone

    git submodule update --init --recursive

### Update All Submodules

    git submodule update --remote

### Remove a Submodule

    git submodule deinit -f projects/my-project

    git rm -f projects/my-project

    rm -rf .git/modules/projects/my-project

---

## Vision

generate-ai-stocks evolves into a development asset platform that accelerates turning ideas into reality first, then into refined, launchable products.
