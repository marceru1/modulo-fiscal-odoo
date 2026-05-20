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
    # Remove qualquer db_filter existente e insere o correto
    sed -i '/^db_filter/d' "$CONF"
    echo "db_filter = ^${DB_FILTER}$" >> "$CONF"
    echo "INFO [start.sh]: db_filter configurado para ^${DB_FILTER}$"
else
    echo "WARN [start.sh]: DB_FILTER não definido. Odoo vai enxergar todos os bancos."
fi

# Repassa o controle para o entrypoint oficial do Odoo com todos os argumentos
exec /entrypoint.sh "$@"
