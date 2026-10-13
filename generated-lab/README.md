# Generated topology

Run `docker compose up --build -d` in this directory.
Use `docker compose ps` to inspect containers and `docker compose down` to stop them.

## Nodes

- `client-1`: attacker (client); container=`attacker`, hostname=`attacker`
- `router-1`: router (router); container=`router`, hostname=`router`
- `server-1`: server (server); container=`server`, hostname=`server`
- `switch-1`: 交换机 1 (switch)（Docker bridge 虚拟二层交换机，不创建容器）
- `client-2`: client2 (client); container=`client2`, hostname=`client2`
- `client-3`: client3 (client); container=`client3`, hostname=`client3`
- `client-4`: client1 (client); container=`client1`, hostname=`client1`

Client/server non-GUI images include Bash and common Linux tools; interactive Bash displays `root@hostname:~#`. Enter with `docker exec -it <container-name> bash`.
For DNS-safe ASCII node names, the hostname matches the visible name; names containing Chinese, spaces or invalid hostname characters use the node ID as hostname. The container name uses the visible node name where Docker-safe; invalid characters are replaced by hyphens and names consisting entirely of non-ASCII characters fall back to the node ID. The original visible name is kept in the `topology.name` label.
OpenWrt router images retain the shells supplied by their rootfs (usually `sh`).

## Layer-2 networks

Each switch-connected domain (including interconnected switches) maps to one Docker bridge.
All attached physical containers share the same subnet and can communicate without a router.
Switch ports have no IP or MAC; the bridge's first host IP is reserved for the Docker gateway.

- `net_link_link-1` `192.168.2.0/24`: client-1=192.168.2.100, router-1=192.168.2.10
- `net_sw_switch-1` `192.168.4.0/24`: router-1=192.168.4.10, client-4=192.168.4.61, server-1=192.168.4.105, client-2=192.168.4.67, client-3=192.168.4.68

## Links

- `client-1` ↔ `router-1`: `192.168.2.0/24`; 192.168.2.100 / 192.168.2.10
- `router-1` ↔ `switch-1`: `192.168.4.0/24`; 192.168.4.10 / switch port
- `switch-1` ↔ `client-4`: `192.168.4.0/24`; switch port / 192.168.4.61
- `server-1` ↔ `switch-1`: `192.168.4.0/24`; 192.168.4.105 / switch port
- `switch-1` ↔ `client-2`: `192.168.4.0/24`; switch port / 192.168.4.67
- `switch-1` ↔ `client-3`: `192.168.4.0/24`; switch port / 192.168.4.68

## Router image

Router Dockerfiles unpack the bundled OpenWrt ARM64 rootfs. Run on ARM64 or a Docker host with ARM64 emulation.
