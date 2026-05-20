#!/bin/bash
set -e

# ==============================================================================
# Odoo 18.0 — Custom Entrypoint Wrapper
# ==============================================================================
# Injeta DB_FILTER no odoo.conf ANTES de chamar o entrypoint oficial do Odoo.
# O entrypoint oficial (/entrypoint.sh) cuida da conexão com o Postgres
# (lendo HOST, PORT, USER, PASSWORD das env vars). Não bypassamos ele.
#
# Uso no Dokploy:
#   - Container Prod:   DB_FILTER=grupo20mais
#   - Container Testes: DB_FILTER=testes
# ==============================================================================

CONF=/etc/odoo/odoo.conf

if [ -n "$DB_FILTER" ]; then
    # sed -i nao funciona pois precisa criar temp file no /etc/odoo/ (sem permissao)
    # solucao: filtra para /tmp e sobrescreve o arquivo com cp (so precisa de permissao no arquivo)
    grep -v '^db_filter' "$CONF" > /tmp/odoo.conf.tmp
    echo "db_filter = ^${DB_FILTER}$" >> /tmp/odoo.conf.tmp
    cp /tmp/odoo.conf.tmp "$CONF"
    echo "INFO [start.sh]: db_filter configurado para ^${DB_FILTER}$"
else
    echo "WARN [start.sh]: DB_FILTER não definido. Odoo vai enxergar todos os bancos."
fi

# Repassa o controle para o entrypoint oficial do Odoo com todos os argumentos
exec /entrypoint.sh "$@"
