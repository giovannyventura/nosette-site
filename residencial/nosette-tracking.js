/**
 * nosette-tracking.js — Camada de tracking + envio de leads (Nosette Arquitetura)
 *
 * Injetar via <script defer src="/nosette-tracking.js"></script> em TODAS as páginas
 * HTML estáticas do export Next.js, logo antes de </body> (depois dos chunks _next/static).
 *
 * Site é um export estático Next.js com hidratação client-side — os componentes React
 * (form de orçamento, chips) continuam funcionando normalmente; este script SÓ escuta
 * eventos no DOM já hidratado (não substitui nem interfere na lógica React existente).
 *
 * Referência completa: cerebro/clientes/lan4/tracking/NOSETTE-blueprint-tracking-2026-08-25.md
 * Padrão replicado de: cerebro/clientes/lan4/tracking/upload/main.js (lan4EnviaRd, normalização PII)
 *
 * IMPORTANTE PRO VITOR: o formulário "quote-v2__form" (componente React) tem
 * onSubmit={e => e.preventDefault()} — ou seja, o React não faz nada no submit hoje.
 * Este script adiciona um SEGUNDO listener de 'submit' no mesmo <form> (via
 * addEventListener, não sobrescreve o handler do React) que faz o envio real pro RD
 * Station. Se/quando você portar essa lógica de envio pra dentro do componente React
 * (onSubmit nativo), REMOVA a seção "5. FORM DE ORÇAMENTO" deste arquivo pra não
 * duplicar o envio do lead — o resto (GTM, WhatsApp modal, cta_click) pode continuar.
 */

/* ─────────────────────────────────────────────────────────────────────
   1. dataLayer + helpers (mesmo padrão de normalização do main.js da LAN4)
   ───────────────────────────────────────────────────────────────────── */
window.dataLayer = window.dataLayer || [];

var NOSETTE_RD_TOKEN = 'd5d170dfe71825a3ebc37e6699f10652'; // token público de conversão RD — mesma conta LAN4 (ver blueprint seção 6)

/* ─── Código de monitoramento RD Station (Path B, 2026-09-03) ───────────
   Rastreador nativo do RD — grava o cookie __trf.src e atribui a origem
   do lead (orgânico/direto/referral/paga), que a API de conversão sozinha
   não cobre sem UTM na URL. Mesma conta da LAN4 → MESMO ID de loader.

   >>> AÇÃO NECESSÁRIA: substituir NOSETTE_RD_LOADER_ID pelo ID da conta.
   RD Station Marketing → Configurações → Código de monitoramento →
   "Copiar código". src:
   https://d335luupugsy2.cloudfront.net/js/loader-scripts/<UUID>-loader.js
   Cole só o <UUID> abaixo (é o MESMO usado no main.js da LAN4). */
var NOSETTE_RD_LOADER_ID = 'c6fb78de-10d6-4e17-8ad6-85f5e6ba1008';
if (NOSETTE_RD_LOADER_ID && NOSETTE_RD_LOADER_ID.indexOf('COLE-O-ID') === -1) {
  (function () {
    var s = document.createElement('script');
    s.type = 'text/javascript';
    s.async = true;
    s.src = 'https://d335luupugsy2.cloudfront.net/js/loader-scripts/' + NOSETTE_RD_LOADER_ID + '-loader.js';
    (document.head || document.body).appendChild(s);
  })();
}
var NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM = 'nosette-form-orcamento';
var NOSETTE_RD_FUNIL_IDENTIFICADOR_WHATSAPP = 'nosette-whatsapp-click';
var NOSETTE_WHATSAPP_NUMERO = '5511921288889';
var NOSETTE_WHATSAPP_MSG_PADRAO = 'Olá! Gostaria de solicitar um orçamento.';

function nosetteEventId() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'evt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function nosetteNormalizeEmail(raw) {
  return (raw || '').trim().toLowerCase();
}

/* Telefone cru → só dígitos com DDI 55. Mesma validação da LAN4: exige DDD real
   (11-99) e celular de 9 dígitos começando com 9 — evita PII incorreta nas
   plataformas quando o usuário digita telefone incompleto. */
function nosettePhoneDigits(raw) {
  var d = (raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 13 && d.slice(0, 2) === '55') return d;
  if (d.length === 11) {
    var ddd = parseInt(d.slice(0, 2), 10);
    if (ddd >= 11 && ddd <= 99 && d.charAt(2) === '9') return '55' + d;
  }
  return '';
}
function nosetteNormalizePhoneGoogle(raw) {
  var d = nosettePhoneDigits(raw);
  return d ? '+' + d : ''; // Enhanced Conversions (Google Ads): E.164 com '+'
}
function nosetteNormalizePhoneMeta(raw) {
  return nosettePhoneDigits(raw); // Advanced Matching/CAPI (Meta): só dígitos, sem '+'
}

function nosetteSplitName(nome) {
  var parts = (nome || '').trim().split(/\s+/);
  return {
    first: (parts[0] || '').toLowerCase(),
    last: (parts.length > 1 ? parts[parts.length - 1] : '').toLowerCase()
  };
}

/* Envio ao RD Station — API de conversão v2 (mesmo padrão lan4EnviaRd).
   Business logic (pipeline/estágio/dono do deal) fica no workflow do RD
   Marketing configurado na interface, não aqui — ver blueprint seção 6.

   MIGRAÇÃO 2026-09-03 (v1.3 → v2): a API 1.3 não populava os campos
   nativos "Origem"/"Fonte" do card — só os cf_utm_* (texto livre). A v2
   (api.rd.services/platform/conversions, envelope event_type/event_family
   =CDP) resolve "Origem"/"Fonte" a partir de traffic_source/traffic_medium/
   traffic_campaign/traffic_value. Os call sites continuam passando o
   payload no formato antigo; a conversão pro envelope v2 acontece aqui. */
/* API Key da conversão v2 (query ?api_key=). Na maioria das contas RD é o
   MESMO valor do token público antigo da v1.3 (por isso reusamos
   NOSETTE_RD_TOKEN). Se o 1º lead de teste voltar 401/invalid: gerar a
   chave em RD Station Marketing → Integrações → API Key e colar aqui.
   Mesma conta da LAN4 → mesma chave do main.js. */
var NOSETTE_RD_API_KEY = NOSETTE_RD_TOKEN;

function nosetteRdV2Envelope(payload) {
  var p = Object.assign({}, payload);
  var identificador = p.identificador || p.conversion_identifier;
  delete p.identificador;
  delete p.token_rdstation;
  delete p.conversion_identifier;
  p.conversion_identifier = identificador;
  if (p.nome != null && p.name == null) { p.name = p.nome; }
  delete p.nome;
  Object.keys(p).forEach(function (k) {
    if (p[k] === '' || p[k] == null) delete p[k];
  });
  return { event_type: 'CONVERSION', event_family: 'CDP', payload: p };
}

function nosetteEnviaRd(payload) {
  return fetch('https://api.rd.services/platform/conversions?api_key=' + encodeURIComponent(NOSETTE_RD_API_KEY), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(nosetteRdV2Envelope(payload))
  });
}

/* UTMs → sessionStorage (persiste na navegação). Anexado ao payload do RD e à
   mensagem do WhatsApp SOMENTE se existir utm_source real na URL de entrada —
   nunca inventar origem de mídia paga (regra da LAN4, replicada aqui). */
var NOSETTE_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

(function () {
  try {
    var qs = new URLSearchParams(window.location.search);
    var found = {};
    NOSETTE_UTM_KEYS.forEach(function (k) { var v = qs.get(k); if (v) found[k] = v; });
    if (Object.keys(found).length) sessionStorage.setItem('nosette_utms', JSON.stringify(found));
  } catch (e) { /* sessionStorage indisponível: segue sem UTMs */ }
})();

function nosetteGetUtms() {
  try { return JSON.parse(sessionStorage.getItem('nosette_utms') || '{}'); }
  catch (e) { return {}; }
}

/* Referrer da PRIMEIRA página da sessão → sessionStorage. Capturado na
   entrada (não no submit — aí document.referrer já seria a própria página
   do site). Usado só como ÚLTIMO fallback de origem, quando não há UTM
   nem cookie __trf.src (caso típico: clique rápido no botão de WhatsApp
   antes do rastreador do RD gravar o cookie). */
(function () {
  try {
    if (sessionStorage.getItem('nosette_ref') === null) {
      sessionStorage.setItem('nosette_ref', document.referrer || '');
    }
  } catch (e) { /* sessionStorage indisponível: segue sem referrer */ }
})();

/* Deriva {source, medium} a partir de um referrer. Vocabulário alinhado
   ao que o RD entende (medium decide a categoria "Origem"):
   - google/bing/yahoo/duckduckgo        → organic  → "Busca Orgânica"
   - instagram/facebook/linkedin/youtube
     /tiktok/t.co(twitter)/pinterest     → social   → "Social"
   - qualquer outro domínio externo      → referral → "Referência"
   - sem referrer / mesmo domínio        → '' (não anexa nada) */
function nosetteRefOrigem(ref) {
  if (!ref) return null;
  var host;
  try { host = new URL(ref).hostname.replace(/^www\./, '').toLowerCase(); }
  catch (e) { return null; }
  if (!host || host === location.hostname.replace(/^www\./, '').toLowerCase()) return null;
  var SEARCH = /(^|\.)(google|bing|yahoo|duckduckgo|ecosia|yandex)\./;
  var SOCIAL = /(^|\.)(instagram|facebook|fb|l\.facebook|lm\.facebook|linkedin|lnkd|youtube|youtu\.be|tiktok|t\.co|twitter|x|pinterest|reddit|threads)\.?/;
  if (SEARCH.test(host)) return { source: host.split('.').slice(-2, -1)[0] || host, medium: 'organic' };
  if (SOCIAL.test(host)) {
    var name = host.split('.').slice(-2, -1)[0] || host;
    if (name === 'fb' || host.indexOf('facebook') > -1) name = 'facebook';
    if (host === 't.co' || name === 'x') name = 'twitter';
    if (host === 'youtu' || host.indexOf('youtube') > -1) name = 'youtube';
    return { source: name, medium: 'social' };
  }
  return { source: host, medium: 'referral' };
}

/* Cookie __trf.src — gravado pelo código de monitoramento nativo do RD
   (Path B). Fonte de verdade de atribuição do RD (cobre orgânico/direto/
   referral, não só UTM). Se presente, vai em traffic_source. */
function nosetteTrfSrc() {
  try {
    var m = document.cookie.match(/(?:^|;\s*)__trf\.src=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch (e) { return ''; }
}

/* Campos de atribuição (traffic_*) para a API de conversão v2 — é ISSO
   que popula os campos nativos "Origem"/"Fonte" no card do lead. Os
   cf_utm_* continuam indo em paralelo (histórico/fallback, texto livre).
   Regra da LAN4 mantida: só anexa origem se houver dado real (UTM na URL
   OU cookie __trf.src). */
function nosetteUtmPayload() {
  var u = nosetteGetUtms();
  var trf = nosetteTrfSrc();
  var p = {};
  /* Prioridade de atribuição:
     1. cookie __trf.src (rastreador nativo do RD — mais completo)
     2. UTMs da URL de entrada
     3. referrer da 1ª página (só source+medium derivados) */
  if (trf) {
    p.traffic_source = trf;
  } else if (u.utm_source) {
    p.traffic_source   = u.utm_source;
    if (u.utm_medium)   p.traffic_medium   = u.utm_medium;
    if (u.utm_campaign) p.traffic_campaign = u.utm_campaign;
    if (u.utm_term)     p.traffic_value    = u.utm_term;
  } else {
    var ref = nosetteRefOrigem(sessionStorage.getItem('nosette_ref'));
    if (ref) { p.traffic_source = ref.source; p.traffic_medium = ref.medium; }
  }
  if (u.utm_source)   p.cf_utm_source   = u.utm_source;
  if (u.utm_medium)   p.cf_utm_medium   = u.utm_medium;
  if (u.utm_campaign) p.cf_utm_campaign = u.utm_campaign;
  if (u.utm_term)     p.cf_utm_term     = u.utm_term;
  if (u.utm_content)  p.cf_utm_content  = u.utm_content;
  return p;
}

/* Chamar SÓ no callback de sucesso do envio ao RD Station — mesmo padrão
   lan4PushLead.

   eventName separa os dois fluxos (padrão LAN4 — cada um tem tag/conversão
   própria no GTM, NÃO compartilham):
   - 'lead_form_submit'      → form de orçamento. Dispara: GA4 generate_lead,
                               GAds "Conversao Lead - Site Novo", Meta Pixel Lead.
   - 'whatsapp_lead_submit'  → modal do WhatsApp. Dispara: GA4 whatsapp_lead,
                               GAds "Botão de WhatsApp", Meta Pixel Contact
                               (com advanced matching). NÃO conta como Lead no
                               Meta nem como generate_lead no GA4. */
function nosettePushLead(identificador, p, eventName) {
  var name = nosetteSplitName(p.nome);
  window.dataLayer.push({
    event: eventName || 'lead_form_submit',
    form_identifier: identificador,
    event_id: p._eventId || nosetteEventId(),
    lead: {
      tipo_projeto: p.tipo_projeto || '',
      servico_de_interesse: p.servico_de_interesse || '',
      urgencia: p.urgencia || '',
      metragem: p.metragem || ''
    },
    user_data: {
      email: nosetteNormalizeEmail(p.email),
      phone: nosetteNormalizePhoneGoogle(p.telefone),
      phone_meta: nosetteNormalizePhoneMeta(p.telefone),
      first_name: name.first,
      last_name: name.last
    }
  });
}

/* ─────────────────────────────────────────────────────────────────────
   2. form_start — primeira interação com o form de orçamento (1x por form)
   ───────────────────────────────────────────────────────────────────── */
document.addEventListener('click', function (e) {
  var chip = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__chip') : null;
  var input = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__input') : null;
  var el = chip || input;
  if (!el) return;
  var form = el.closest('form');
  if (!form || form.dataset.nosetteStarted) return;
  form.dataset.nosetteStarted = '1';
  window.dataLayer.push({ event: 'form_start', form_identifier: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM });
}, true);

/* input (etapa 2) foca antes de clicar — cobre esse caminho também, e é o
   sinal de que a etapa 2 montou: dispara form_step nº 2 (1x por form).
   O funil GA4 fica form_start → form_step(1) → form_step(2) → generate_lead. */
document.addEventListener('focusin', function (e) {
  var input = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__input') : null;
  if (!input) return;
  var form = input.closest('form');
  if (!form) return;
  if (!form.dataset.nosetteStarted) {
    form.dataset.nosetteStarted = '1';
    window.dataLayer.push({ event: 'form_start', form_identifier: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM });
  }
  if (!form.dataset.nosetteStep2) {
    form.dataset.nosetteStep2 = '1';
    window.dataLayer.push({
      event: 'form_step',
      form_identifier: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM,
      form_step_number: 2,
      form_step_total: 2
    });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   3. form_step + captura persistente dos chips da etapa 1
   ───────────────────────────────────────────────────────────────────── */

/* O form de orçamento é um wizard React: ao ir pra etapa 2, os campos de
   chip da etapa 1 (Tipo de projeto / Tipo de serviço / Urgência) são
   DESMONTADOS do DOM. Se lermos `.quote-v2__chip.is-active` só no submit
   (etapa 2), sempre volta vazio. Por isso guardamos a seleção da etapa 1
   em NOSETTE_STEP1 a cada clique de chip, enquanto ela ainda está montada. */
var NOSETTE_STEP1 = { tipo_projeto: '', servico_de_interesse: '', urgencia: '' };

function nosetteLeChipsEtapa1() {
  var form = document.querySelector('.quote-v2__form');
  if (!form) return;
  var LABEL_TO_KEY = {
    'Tipo de projeto': 'tipo_projeto',
    'Tipo de serviço': 'servico_de_interesse',
    'Urgência': 'urgencia'
  };
  var fields = form.querySelectorAll('.quote-v2__field');
  for (var i = 0; i < fields.length; i++) {
    var label = fields[i].querySelector('.quote-v2__label');
    if (!label) continue;
    var key = LABEL_TO_KEY[label.textContent.trim()];
    if (!key) continue;
    // só sobrescreve se ESTE campo tem chips no DOM agora (etapa 1 montada);
    // se a etapa 1 já desmontou, mantém o valor guardado no clique anterior
    var todosChips = fields[i].querySelectorAll('.quote-v2__chip');
    if (!todosChips.length) continue;
    var ativos = fields[i].querySelectorAll('.quote-v2__chip.is-active');
    var vals = Array.prototype.map.call(ativos, function (c) { return c.textContent.trim(); });
    // multi-seleção só faz sentido em "Tipo de serviço"; nos outros pegamos o 1º
    NOSETTE_STEP1[key] = key === 'servico_de_interesse' ? vals.join(', ') : (vals[0] || '');
  }
}

/* Delegado no document: pega clique em qualquer chip da etapa 1. Roda no
   próximo tick pra ler o DOM já com a classe .is-active atualizada pelo React. */
document.addEventListener('click', function (e) {
  var chip = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__chip') : null;
  if (!chip) return;
  setTimeout(nosetteLeChipsEtapa1, 0);
}, true);

document.addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('.quote-v2__form .quote-v2__submit') : null;
  if (!btn || btn.type === 'submit' || btn.disabled) return; // só o "Próximo" (type=button); "Enviar" tratado na seção 5
  nosetteLeChipsEtapa1(); // snapshot final da etapa 1 antes de ela desmontar
  window.dataLayer.push({
    event: 'form_step',
    form_identifier: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM,
    form_step_number: 1,
    form_step_total: 2
  });
}, true);

/* ─────────────────────────────────────────────────────────────────────
   4. cta_click — dois caminhos:
      (a) qualquer elemento com data-cta="<id>" [data-cta-location opcional]
          — usar quando o Vitor quiser instrumentar um botão novo no HTML;
      (b) fallback por classe CSS — os CTAs que já existem no export Next.js
          não têm data-cta, então mapeamos as classes conhecidas aqui. Assim
          cta_click passa a disparar em TODAS as páginas sem editar HTML.
          Se um dia esses botões ganharem data-cta próprio, o caminho (a)
          vence (checado primeiro) e não há push duplo.
   ───────────────────────────────────────────────────────────────────── */
var NOSETTE_CTA_CLASSES = {
  'hero-v2__hero-cta':      { id: 'hero_conheca_projetos',   location: 'hero' },
  'hero-v2__cta':           { id: 'header_comecar_projeto',   location: 'header' },
  'about-v2__cta':          { id: 'about_comece_projeto',     location: 'quem_somos' },
  'projects-v2__cta':       { id: 'portfolio_ver_mais',       location: 'portfolio' },
  'specialties-v3__cta':    { id: 'especialidades_conheca',   location: 'especialidades' },
  'mobile-sticky-cta__btn': { id: 'sticky_comecar_projeto',   location: 'mobile_sticky' }
};

document.addEventListener('click', function (e) {
  if (!e.target.closest) return;

  // (a) data-cta explícito tem prioridade
  var elData = e.target.closest('[data-cta]');
  if (elData) {
    window.dataLayer.push({
      event: 'cta_click',
      cta_id: elData.getAttribute('data-cta'),
      cta_text: (elData.textContent || '').trim().slice(0, 80),
      cta_location: elData.getAttribute('data-cta-location') || ''
    });
    return;
  }

  // (b) fallback por classe CSS conhecida
  for (var cls in NOSETTE_CTA_CLASSES) {
    var elCls = e.target.closest('.' + cls);
    if (elCls) {
      var map = NOSETTE_CTA_CLASSES[cls];
      window.dataLayer.push({
        event: 'cta_click',
        cta_id: map.id,
        cta_text: (elCls.textContent || '').trim().slice(0, 80),
        cta_location: map.location
      });
      return;
    }
  }
});

/* ─────────────────────────────────────────────────────────────────────
   5. FORM DE ORÇAMENTO — captura dos dados da etapa 1 (chips) + etapa 2
      (inputs) e envio real ao RD Station no submit.
      ⚠️ VER NOTA NO TOPO DO ARQUIVO — remover esta seção se o Vitor portar
      o envio pra dentro do componente React.
   ───────────────────────────────────────────────────────────────────── */
(function () {
  function coletaInput(form, name) {
    var el = form.querySelector('.quote-v2__input[name="' + name + '"]');
    return el ? (el.value || '').trim() : '';
  }

  // Dedup: o submit chega 2x (evento nativo + re-disparo do React). Guarda a
  // assinatura do último envio e ignora repetição dentro de 4s.
  var nosetteUltimoSubmit = { sig: '', ts: 0 };

  document.addEventListener('submit', function (e) {
    var form = e.target.closest ? e.target.closest('.quote-v2__form') : null;
    if (!form) return;
    // Não chama e.preventDefault() aqui — o handler inline do React já faz isso.
    // Esse listener roda em paralelo (addEventListener não sobrescreve o onSubmit React).

    var nome = coletaInput(form, 'nome');
    var email = coletaInput(form, 'email');
    var telefone = coletaInput(form, 'telefone');
    var metragem = coletaInput(form, 'metragem');

    if (!nome || !email || !telefone) {
      console.warn('[Nosette][form] submit sem nome/email/telefone preenchidos — lead não enviado.');
      return;
    }

    var agora = Date.now();
    var sig = (email + '|' + telefone + '|' + metragem).toLowerCase();
    if (sig === nosetteUltimoSubmit.sig && (agora - nosetteUltimoSubmit.ts) < 4000) {
      return; // envio duplicado do mesmo lead — ignora
    }
    nosetteUltimoSubmit = { sig: sig, ts: agora };

    // Etapa 1 já foi desmontada nesse ponto — usa o snapshot feito na seção 3.
    nosetteLeChipsEtapa1(); // no-op se a etapa 1 não estiver mais no DOM; mantém o último valor
    var tipoProjeto = NOSETTE_STEP1.tipo_projeto;
    var tipoServico = NOSETTE_STEP1.servico_de_interesse;
    var urgencia = NOSETTE_STEP1.urgencia;

    var eventId = nosetteEventId();
    var lead = {
      nome: nome, email: email, telefone: telefone, metragem: metragem,
      tipo_projeto: tipoProjeto, servico_de_interesse: tipoServico, urgencia: urgencia,
      _eventId: eventId
    };

    var btn = form.querySelector('button[type="submit"]');
    var btnTextoOriginal = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }

    nosetteEnviaRd(Object.assign({
      token_rdstation: NOSETTE_RD_TOKEN,
      identificador: NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM,
      email: email,
      nome: nome,
      mobile_phone: nosetteNormalizePhoneMeta(telefone),
      // Campos Nosette-namespaced — NUNCA reusar cf_tipo_de_projeto / cf_servico_de_interesse
      // (esses são do Lan4Films/audiovisual; cf_tipo_de_projeto é RADIO com opções de
      // filme, rejeita "Residencial"/"Comercial"). O RD Marketing auto-cria estes 4
      // como texto livre na 1ª conversão. Mapeamento p/ campos estruturados do RD CRM
      // (Nosette - Tipo de projeto (arquitetura) etc.) é feito no workflow do RD Mkt.
      cf_nosette_tipo_de_projeto: tipoProjeto,
      cf_nosette_tipo_de_servico: tipoServico,
      cf_nosette_urgencia_da_obra: urgencia,
      cf_nosette_metragem_do_projeto: metragem
    }, nosetteUtmPayload()))
    .then(function (r) {
      return r.json().then(function (data) {
        console.log('[Nosette][RD Station] status:', r.status, 'response:', data);
        if (!r.ok) throw new Error(r.status + ' – ' + JSON.stringify(data));
        nosettePushLead(NOSETTE_RD_FUNIL_IDENTIFICADOR_FORM, lead);
        // Feedback de sucesso — genérico até o Vitor definir o design final da confirmação.
        var msgExistente = form.querySelector('.nosette-form-msg');
        if (msgExistente) msgExistente.remove();
        var msg = document.createElement('div');
        msg.className = 'nosette-form-msg';
        msg.style.cssText = 'margin-top:14px;padding:12px;border-radius:8px;background:rgba(0,150,80,.12);color:#0a7a44;font-size:14px;';
        msg.textContent = 'Recebemos seu pedido de orçamento! Em breve entraremos em contato.';
        form.appendChild(msg);
      });
    })
    .catch(function (err) {
      console.error('[Nosette][RD Station] erro:', err);
      var msgExistente = form.querySelector('.nosette-form-msg');
      if (msgExistente) msgExistente.remove();
      var msg = document.createElement('div');
      msg.className = 'nosette-form-msg';
      msg.style.cssText = 'margin-top:14px;padding:12px;border-radius:8px;background:rgba(200,40,40,.12);color:#c02828;font-size:14px;';
      msg.textContent = 'Ocorreu um erro ao enviar. Tente novamente ou fale pelo WhatsApp.';
      form.appendChild(msg);
    })
    .finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = btnTextoOriginal; }
    });
  }, true);
})();

/* ─────────────────────────────────────────────────────────────────────
   6. WHATSAPP — modal de captura (nome/e-mail/telefone) antes de abrir o
      wa.me, com envio de lead ao RD Station — replica o padrão LAN4
      (main.js linhas ~1301-1406). Intercepta cliques em qualquer link
      cujo href contenha "wa.me".
   ───────────────────────────────────────────────────────────────────── */
(function () {
  (function () {
    var style = document.createElement('style');
    style.textContent = '#nosette-whatsapp-modal-overlay *{box-sizing:border-box;max-width:100%;}'
      + '#nosette-whatsapp-form input:focus{outline:none;border-color:#B08968 !important;background:rgba(176,137,104,.08) !important;}'
      + '#nosette-whatsapp-form input::placeholder{color:rgba(0,0,0,.4);}'
      + '#nosette-whatsapp-enviar:hover{background:#1EBE5B;}'
      + '#nosette-whatsapp-cancelar:hover{color:#000;}';
    document.head.appendChild(style);
  })();

  function nosetteWhatsappLink(mensagemBase) {
    var utms = nosetteGetUtms();
    var msg = mensagemBase || NOSETTE_WHATSAPP_MSG_PADRAO;
    if (utms.utm_source) msg += ' (origem: ' + utms.utm_source + ')';
    return 'https://wa.me/' + NOSETTE_WHATSAPP_NUMERO + '?text=' + encodeURIComponent(msg);
  }

  /* whatsapp_click = intenção de contato (abriu o modal / seguiu pro wa.me).
     Alimenta GA4 whatsapp_click + Meta Pixel Contact (sem PII). Dispara em
     TODO caminho (sucesso ou falha do RD) — a intenção aconteceu. */
  function nosetteWhatsappPushEvento() {
    window.dataLayer.push({
      event: 'whatsapp_click',
      cta_location: 'modal',
      event_id: nosetteEventId()
    });
  }

  function nosetteCriaModalWhatsapp(hrefOriginal) {
    var overlay = document.createElement('div');
    overlay.id = 'nosette-whatsapp-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);'
      + 'display:flex;align-items:center;justify-content:center;z-index:10001;'
      + 'padding:16px;box-sizing:border-box;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;color:#1a1a1a;border-radius:14px;padding:28px 24px;'
      + 'width:100%;max-width:min(360px,calc(100vw - 32px));font-family:inherit;'
      + 'border:1px solid rgba(0,0,0,.08);box-shadow:0 20px 60px rgba(0,0,0,.25);'
      + 'box-sizing:border-box;';
    box.innerHTML =
      '<h3 style="margin:0 0 4px;font-size:19px;color:#1a1a1a;">Antes de continuar</h3>'
      + '<p style="margin:0 0 18px;font-size:13px;color:rgba(0,0,0,.6);">Deixe seus dados pra já entrarmos em contato mesmo se a conversa cair.</p>'
      + '<div id="nosette-whatsapp-form">'
      + '  <input name="nome" autocomplete="name" placeholder="Nome" required style="width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;border:1.5px solid rgba(0,0,0,.15);border-radius:8px;font-size:14px;background:rgba(0,0,0,.03);color:#1a1a1a;">'
      + '  <input name="email" type="email" autocomplete="email" placeholder="Seu melhor e-mail" required style="width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;border:1.5px solid rgba(0,0,0,.15);border-radius:8px;font-size:14px;background:rgba(0,0,0,.03);color:#1a1a1a;">'
      + '  <input name="telefone" type="tel" autocomplete="tel-national" placeholder="WhatsApp com DDD (ex.: 11998765432)" required style="width:100%;box-sizing:border-box;padding:11px 12px;margin-bottom:10px;border:1.5px solid rgba(0,0,0,.15);border-radius:8px;font-size:14px;background:rgba(0,0,0,.03);color:#1a1a1a;">'
      + '  <div id="nosette-whatsapp-erro" style="color:#c02828;font-size:12px;min-height:16px;margin-bottom:10px;"></div>'
      + '  <button type="button" id="nosette-whatsapp-enviar" style="width:100%;padding:13px;background:#25D366;color:#fff;border:none;border-radius:999px;font-size:15px;font-weight:700;cursor:pointer;">Continuar no WhatsApp</button>'
      + '  <button type="button" id="nosette-whatsapp-cancelar" style="width:100%;padding:9px;background:transparent;color:rgba(0,0,0,.55);border:none;font-size:13px;cursor:pointer;margin-top:6px;">Cancelar</button>'
      + '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    var erroEl = box.querySelector('#nosette-whatsapp-erro');
    var enviarBtn = box.querySelector('#nosette-whatsapp-enviar');
    var cancelarBtn = box.querySelector('#nosette-whatsapp-cancelar');
    var nomeInput = box.querySelector('[name="nome"]');
    var emailInput = box.querySelector('[name="email"]');
    var telInput = box.querySelector('[name="telefone"]');

    function fecha() {
      overlay.remove();
    }

    cancelarBtn.addEventListener('click', fecha);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) fecha(); });
    document.addEventListener('keydown', function escFecha(e) {
      if (e.key === 'Escape') { fecha(); document.removeEventListener('keydown', escFecha); }
    });

    enviarBtn.addEventListener('click', function () {
      var nome = (nomeInput.value || '').trim();
      var email = (emailInput.value || '').trim();
      var telefone = (telInput.value || '').trim();

      if (!nome || !email || !telefone) {
        erroEl.textContent = 'Preencha nome, e-mail e telefone pra continuar.';
        return;
      }
      if (!nosettePhoneDigits(telefone)) {
        erroEl.textContent = 'Telefone inválido. Digite DDD + celular (ex.: 11998765432).';
        return;
      }
      erroEl.textContent = '';
      enviarBtn.disabled = true;
      enviarBtn.textContent = 'Enviando…';

      var eventId = nosetteEventId();
      var lead = { nome: nome, email: email, telefone: telefone, _eventId: eventId };

      nosetteEnviaRd(Object.assign({
        token_rdstation: NOSETTE_RD_TOKEN,
        identificador: NOSETTE_RD_FUNIL_IDENTIFICADOR_WHATSAPP,
        email: email,
        nome: nome,
        mobile_phone: nosetteNormalizePhoneMeta(telefone)
      }, nosetteUtmPayload()))
      .then(function (r) {
        return r.json().then(function (data) {
          console.log('[Nosette][RD Station][whatsapp] status:', r.status, 'response:', data);
          if (!r.ok) throw new Error(r.status + ' – ' + JSON.stringify(data));
          // Lead de WhatsApp confirmado no RD: evento PRÓPRIO (não 'lead_form_submit').
          // No GTM 'whatsapp_lead_submit' dispara GA4 whatsapp_lead + GAds
          // "Botão de WhatsApp" + Meta Contact (com advanced matching via user_data).
          nosettePushLead(NOSETTE_RD_FUNIL_IDENTIFICADOR_WHATSAPP, lead, 'whatsapp_lead_submit');
          nosetteWhatsappPushEvento();          // + whatsapp_click (intenção)
          fecha();
          window.open(nosetteWhatsappLink(NOSETTE_WHATSAPP_MSG_PADRAO), '_blank', 'noopener');
        });
      })
      .catch(function (err) {
        console.error('[Nosette][RD Station][whatsapp] erro:', err);
        // RD falhou — NÃO prender o usuário. Ainda assim registramos o
        // whatsapp_click (a intenção de contato aconteceu) e abrimos o wa.me.
        // O whatsapp_lead_submit (com PII pro Meta Contact / GAds "Botão de
        // WhatsApp") fica só no caminho de sucesso — sem confirmação do RD
        // não temos garantia do lead.
        nosetteWhatsappPushEvento();
        fecha();
        window.open(nosetteWhatsappLink(NOSETTE_WHATSAPP_MSG_PADRAO), '_blank', 'noopener');
      });
    });
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a[href*="wa.me"]') : null;
    if (!link) return;
    e.preventDefault();
    nosetteCriaModalWhatsapp(link.getAttribute('href'));
  }, true);
})();
