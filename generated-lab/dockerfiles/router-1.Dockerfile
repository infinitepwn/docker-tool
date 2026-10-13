FROM scratch
ADD assets/openwrt-armsr-armv8-rootfs.tar.gz /
ENV PATH=/usr/sbin:/usr/bin:/sbin:/bin
LABEL topology.role=router
