# Vega SDK build container — Ubuntu 22.04 (Amazon requires 20.04+, x86_64).
# Builds the .vpkg and installs it on a Fire TV Stick over the network (the
# stick in developer mode, reachable at <ip>:5555). It doesn't run the Vega
# Virtual Device: Docker Desktop on Windows passes through no /dev/kvm. Use
# --platform=linux/amd64 if your Docker host is ARM. See docker/README.md.

FROM ubuntu:22.04
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git sudo unzip xz-utils file jq lz4 \
      build-essential python3 python3-pip software-properties-common gnupg \
      libx11-6 libpulse0 libgl1 \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update && apt-get install -y --no-install-recommends libpython3.8-dev \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN useradd -ms /bin/bash dev && echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev

# Pre-create and chown the mount points. Docker seeds a brand-new *named*
# volume from whatever already exists at the mount path in the image, owner
# and permissions included — skip this and the volume comes up root-owned,
# and the installer (running as `dev`) fails with "Permission denied" on
# its very first write.
RUN mkdir -p /home/dev/vega /home/dev/.npm && chown -R dev:dev /home/dev

USER dev
WORKDIR /home/dev

# The Vega SDK is NOT baked into the image — it's ~20GB and Amazon's installer
# expects to run interactively the first time. Install it once, into the named
# volume mounted at /home/dev/vega, so it survives `docker start` across
# sessions instead of re-downloading every time you run the container:
#
#   curl -fsSL https://sdk-installer.vega.labcollab.net/get_vvm.sh | bash && source ~/vega/env
#
# Then `vega --version` should print the active SDK + CLI versions.
