FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates squid \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/spool/squid /var/log/squid /run/squid \
    && chown -R proxy:proxy /var/spool/squid /var/log/squid /run/squid

COPY proxy/squid.conf /etc/squid/squid.conf
COPY proxy/allowed-domains.txt /etc/squid/allowed-domains.txt

COPY proxy/entrypoint.sh /usr/local/bin/lab-proxy

USER proxy
ENTRYPOINT ["sh", "/usr/local/bin/lab-proxy"]

