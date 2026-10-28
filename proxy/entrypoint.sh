#!/bin/sh
set -eu
# Cada domínio vira ".dominio" (vale também para os subdomínios), sem repetição e sem entradas já cobertas
# por outra: o Squid se recusa a iniciar com "x" e ".x" (ou ".a.x" e ".x") na mesma ACL.
normalize() {
  tr 'A-Z' 'a-z' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' -e 's/^\.*/./' | sort -u |
    awk '{ d[NR] = $0 } END {
      for (i = 1; i <= NR; i++) {
        keep = 1
        for (j = 1; j <= NR; j++) {
          if (i != j && length(d[i]) > length(d[j]) && substr(d[i], length(d[i]) - length(d[j]) + 1) == d[j]) keep = 0
        }
        if (keep) print d[i]
      }
    }'
}
printf '%s\n' "${LAB_DENIED_DOMAINS:-}" | normalize > /tmp/proibidos.txt
printf '%s\n' "${LAB_EXTRA_DOMAINS:-}" | normalize > /tmp/extras.txt
for file in /tmp/proibidos.txt /tmp/extras.txt; do
  # Arquivos sempre não vazios: Squid recusa uma ACL sem valores.
  if ! grep -q '[^[:space:]]' "$file"; then printf 'sem-dominios.invalid\n' > "$file"; fi
  if grep -Ev '^$|^\.?[a-z0-9][a-z0-9.-]*$' "$file"; then echo 'domínio inválido' >&2; exit 2; fi
done
exec squid -N -f /etc/squid/squid.conf
