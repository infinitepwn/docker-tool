FROM alpine:3.21
RUN apk add --no-cache bash bash-completion coreutils findutils grep sed less nano vim procps util-linux iproute2 iputils bind-tools traceroute curl wget tcpdump net-tools
ENV SHELL=/bin/bash HOME=/root TERM=xterm-256color
WORKDIR /root
RUN printf '%s\n' 'export PS1="\u@\h:\w\$ "' > /root/.bashrc && printf '%s\n' '[ -f /root/.bashrc ] && . /root/.bashrc' > /root/.bash_profile
CMD ["/bin/bash"]
LABEL topology.role=client
