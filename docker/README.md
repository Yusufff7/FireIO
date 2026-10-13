# Build environment

The Vega SDK only runs on Linux (x86_64), so FireIO is built inside a Docker container. The SDK itself (~20 GB) lives in a named volume rather than the image, so it's installed once and survives container restarts.

## One-time setup

From the repository root:

```bash
docker build -t vega-dev:22.04 docker/
```

```bash
docker run -d --name vega \
  -v "$(pwd):/work/StremioVega" \
  -v vega-sdk:/home/dev/vega \
  -v vega-npm:/home/dev/.npm \
  vega-dev:22.04 sleep infinity
```

On Windows (PowerShell), use `-v "${PWD}:/work/StremioVega"` for the first mount.

Then install the Vega SDK into its volume (interactive, one time):

```bash
docker exec -it vega bash -lc 'curl -fsSL https://sdk-installer.vega.labcollab.net/get_vvm.sh | bash'
```

## Building and installing

Put the Fire TV Stick in developer mode and note its IP address (the device must be reachable from your machine on port 5555). Then:

```bash
docker exec vega bash -lc 'cd /work/StremioVega && scripts/build.sh 1 192.168.1.50:5555'
```

The first argument is the build number. The device only accepts an install with a higher build number than the one already installed, so increase it each time. Leave off the device address to build without installing; the package lands in `build/package/`.

After a Docker or PC restart, bring the container back with `docker start vega`.

## Notes

- **Device logs:** `docker exec vega bash -lc 'export PATH=$HOME/vega/bin:$PATH; vega device start-log-stream --device <ip>:5555'`. The app logs its playback state at WARN level, because the device throttles an app's INFO logging during video playback.
- **Vega Virtual Device:** needs `/dev/kvm`, which Docker Desktop on Windows doesn't provide. On a Linux host, add `--device /dev/kvm --cap-add NET_ADMIN` to `docker run`. `noaddrconfig.c` is an `LD_PRELOAD` shim for a container networking quirk that otherwise stops the virtual device from booting; see the comment at its top.
