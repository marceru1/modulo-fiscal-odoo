#!/bin/bash
set -e

# ==============================================================================
# Odoo 18.0 — Custom Entrypoint Wrapper
# ==============================================================================
# Se DB_NAME estiver definido, inicia Odoo em modo single-database.
# Nesse modo, TODAS as requests usam o banco especificado automaticamente,
# sem precisar de cookie de sessão — resolve o 404 em callbacks do middleware.
#
# Uso no Dokploy:
#   - Container Testes: DB_NAME=testes
#   - Container Prod:   DB_NAME=grupo20mais
# ==============================================================================

if [ -n "$DB_NAME" ]; then
    echo "INFO [start.sh]: Iniciando Odoo em modo single-database: $DB_NAME"
    exec /entrypoint.sh odoo --database "$DB_NAME" -u meu_modulo_fiscal
else
    echo "WARN [start.sh]: DB_NAME não definido. Iniciando em modo multi-database."
    exec /entrypoint.sh "$@"
fi
