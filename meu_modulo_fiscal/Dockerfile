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

USER odoo

# Força a atualização do módulo toda vez que o container iniciar (Autodeploy)
CMD ["odoo", "-u", "meu_modulo_fiscal"]
