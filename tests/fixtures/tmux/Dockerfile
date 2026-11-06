FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server tmux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash harbor && passwd -d harbor \
    && install -d -m 0755 /run/sshd \
    && install -d -m 0700 -o harbor -g harbor /home/harbor/.ssh
RUN printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' \
    'UsePAM no' 'PermitRootLogin no' 'AllowUsers harbor' > /etc/ssh/sshd_config.d/harbor-test.conf
CMD ["sh", "-c", "ssh-keygen -A && install -m 0600 -o harbor -g harbor /test-key.pub /home/harbor/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]
