/**
 * nosette-categoria-fixa.js — adapta a página de categoria fixa (Comercial/
 * Residencial) sem tocar no bundle React minificado do site original.
 *
 * Duas responsabilidades:
 *
 * 1. Portfólio: clica programaticamente no filtro nativo "Comercial"/
 *    "Residencial" que o próprio componente React já tem (barra de filtro
 *    escondida via CSS). Isso é melhor do que remover cards do DOM à mão —
 *    tentamos isso antes e o masonry (posicionamento via JS, não CSS Grid)
 *    não recalculava as posições, deixando buracos enormes no grid. Usando
 *    o filtro nativo, o próprio React recalcula tudo do jeito certo.
 *
 * 2. Formulário: esconde o campo "Tipo de projeto" (já nasce com
 *    style="display:none" no HTML, isso aqui é reforço) e mantém o valor
 *    selecionado no estado do React clicando 1x no chip certo — sem isso o
 *    botão "Próximo" nunca habilita, porque o React exige os 3 campos da
 *    etapa 1 preenchidos. O clique sintético dispara form_start/form_step
 *    falsos no dataLayer; removemos esses eventos logo em seguida pra não
 *    poluir o funil do GA4 antes do usuário interagir de verdade.
 *
 * Carregar DEPOIS de nosette-tracking.js (ambos com defer, ordem do <script> preservada).
 */
(function () {
  /* ---------- 1. Portfólio: aciona o filtro nativo ---------- */
  function aplicaFiltroPortfolio() {
    var botoes = document.querySelectorAll('.projects-v2__filter');
    if (!botoes.length) return false;
    for (var i = 0; i < botoes.length; i++) {
      if (botoes[i].textContent.trim() === window.NOSETTE_CATEGORIA_FIXA) {
        botoes[i].click();
        return true;
      }
    }
    return false;
  }

  var tentativasFiltro = 0;
  var timerFiltro = setInterval(function () {
    tentativasFiltro++;
    if (aplicaFiltroPortfolio() || tentativasFiltro > 40) clearInterval(timerFiltro);
  }, 100);

  /* ---------- 2. Formulário: campo "Tipo de projeto" ---------- */
  function encontraCampoTipoProjeto() {
    var form = document.querySelector('.quote-v2__form');
    if (!form) return null;
    var fields = form.querySelectorAll('.quote-v2__field');
    for (var i = 0; i < fields.length; i++) {
      var label = fields[i].querySelector('.quote-v2__label');
      if (label && label.textContent.trim() === 'Tipo de projeto') return fields[i];
    }
    return null;
  }

  function selecionaChipFixo(campo) {
    var chips = campo.querySelectorAll('.quote-v2__chip');
    for (var j = 0; j < chips.length; j++) {
      if (chips[j].textContent.trim() === window.NOSETTE_CATEGORIA_FIXA) return chips[j];
    }
    return null;
  }

  var tentativasForm = 0;
  var timerForm = setInterval(function () {
    tentativasForm++;
    var campo = encontraCampoTipoProjeto();
    if (campo) {
      clearInterval(timerForm);
      var chip = selecionaChipFixo(campo);
      if (chip && !chip.classList.contains('is-active')) {
        var tamanhoAntes = (window.dataLayer || []).length;
        chip.click();
        setTimeout(function () {
          if (window.dataLayer && window.dataLayer.length > tamanhoAntes) {
            window.dataLayer.splice(tamanhoAntes);
          }
          var form = document.querySelector('.quote-v2__form');
          if (form) {
            delete form.dataset.nosetteStarted;
            delete form.dataset.nosetteStep2;
          }
        }, 0);
      }
      campo.classList.add('nosette-hide-tipo-projeto');
    } else if (tentativasForm > 40) {
      clearInterval(timerForm);
    }
  }, 100);

  // Reforça o valor travado a cada clique de chip/Próximo e no submit final.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__submit, .quote-v2__form .quote-v2__chip') : null;
    if (!btn) return;
    if (window.NOSETTE_STEP1 && window.NOSETTE_CATEGORIA_FIXA) {
      setTimeout(function () {
        window.NOSETTE_STEP1.tipo_projeto = window.NOSETTE_CATEGORIA_FIXA;
      }, 0);
    }
  }, true);

  document.addEventListener('submit', function (e) {
    var form = e.target.closest ? e.target.closest('.quote-v2__form') : null;
    if (!form) return;
    if (window.NOSETTE_STEP1 && window.NOSETTE_CATEGORIA_FIXA) {
      window.NOSETTE_STEP1.tipo_projeto = window.NOSETTE_CATEGORIA_FIXA;
    }
  }, true);
})();
