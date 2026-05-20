# ==============================================================================
# Odoo 18.0 — Dockerfile (Produção)
# ==============================================================================
# A raiz deste repo É o módulo meu_modulo_fiscal.
# O Dockerfile copia ele direto para o extra-addons do Odoo.
# ==============================================================================

FROM odoo:18.0

USER root

# Copia todo o módulo para o diretório de extra-addons
# (o build context é a raiz do repo, que já é o próprio módulo)
COPY --chown=odoo:odoo . /mnt/extra-addons/meu_modulo_fiscal/

# Copia a configuração de produção (substitui a padrão do container)
COPY --chown=odoo:odoo odoo.conf.docker /etc/odoo/odoo.conf

# Script wrapper: injeta DB_FILTER no conf antes de chamar o entrypoint oficial
# Permite que cada container (prod / testes) use seu próprio db_filter via env var
COPY start.sh /start.sh
RUN chmod +x /start.sh

USER odoo

# Entrypoint customizado injeta DB_FILTER → chama entrypoint oficial do Odoo → sobe
ENTRYPOINT ["/start.sh"]
CMD ["odoo", "-u", "meu_modulo_fiscal"]
