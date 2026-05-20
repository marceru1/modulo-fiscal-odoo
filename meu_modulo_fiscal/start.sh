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
    echo "WARN [start.sh]: DB_FILTER definido mas ignorado — use ?db= na URL do callback."
    echo "INFO [start.sh]: db_filter nao aplicado (causa conflito com callbacks via Docker bridge)."
fi

echo "INFO [start.sh]: Iniciando Odoo sem db_filter. Use ?db=NOME nas URLs de callback."

# Repassa o controle para o entrypoint oficial do Odoo com todos os argumentos
exec /entrypoint.sh "$@"
