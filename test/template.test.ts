import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Template, parseTemplate, renderTemplate } from '../src/config/template.js';
import { makeIssue } from './helpers.js';

const issue = makeIssue({ identifier: 'ABC-123', title: 'Fix the widget', labels: ['bug', 'urgent'] });
const context = { issue, attempt: null };

describe('prompt template rendering', () => {
  it('renders issue fields and attempt', () => {
    const text = renderTemplate('{{ issue.identifier }} — {{ issue.title }} (#{{ attempt }})', {
      issue,
      attempt: 2,
    });
    assert.equal(text, 'ABC-123 — Fix the widget (#2)');
  });

  it('renders nested arrays so templates can iterate', () => {
    const text = renderTemplate('{% for label in issue.labels %}{{ forloop.index }}:{{ label }} {% endfor %}', context);
    assert.equal(text, '1:bug 2:urgent ');
  });

  it('renders null values as an empty string', () => {
    assert.equal(renderTemplate('[{{ attempt }}]', context), '[]');
    assert.equal(renderTemplate('[{{ issue.description }}]', { issue: makeIssue({ description: null }), attempt: null }), '[]');
  });

  it('supports if / elsif / else and comparisons', () => {
    const template = parseTemplate(
      [
        '{% if issue.priority == 1 %}urgent',
        '{% elsif issue.priority != null %}normal',
        '{% else %}unset{% endif %}',
      ].join(''),
    );
    assert.equal(template.render({ issue: makeIssue({ priority: 1 }) }), 'urgent');
    assert.equal(template.render({ issue: makeIssue({ priority: 3 }) }), 'normal');
    assert.equal(template.render({ issue: makeIssue({ priority: null }) }), 'unset');
  });

  it('supports unless, contains, and boolean operators', () => {
    const template = parseTemplate('{% unless issue.labels contains "wontfix" %}go{% endunless %}');
    assert.equal(template.render({ issue }), 'go');
    assert.equal(
      parseTemplate('{% if issue.labels contains "bug" and issue.state == "open" %}yes{% endif %}').render({ issue }),
      'yes',
    );
    assert.equal(parseTemplate('{{ issue.labels | size }}').render({ issue }), '2');
  });

  it('supports filters including default, join, upcase and json', () => {
    assert.equal(renderTemplate('{{ issue.description | default: "no body" }}', { issue: makeIssue({ description: null }) }), 'no body');
    assert.equal(renderTemplate('{{ issue.labels | join: ", " }}', { issue }), 'bug, urgent');
    assert.equal(renderTemplate('{{ issue.title | upcase }}', { issue }), 'FIX THE WIDGET');
    assert.equal(renderTemplate('{{ issue.priority | default: 9 }}', { issue: makeIssue({ priority: null }) }), '9');
    assert.equal(
      renderTemplate('{{ issue.labels | json }}', { issue }),
      '["bug","urgent"]',
    );
  });

  it('supports assign and for-with-else', () => {
    const template = parseTemplate('{% assign name = issue.identifier %}{{ name }}|{% for l in issue.blocked_by %}x{% else %}none{% endfor %}');
    assert.equal(template.render({ issue }), 'ABC-123|none');
  });

  it('supports comments, raw blocks and whitespace control', () => {
    assert.equal(parseTemplate('a{# hidden #}b').render({}), 'ab');
    assert.equal(parseTemplate('{% raw %}{{ not_rendered }}{% endraw %}').render({}), '{{ not_rendered }}');
    assert.equal(parseTemplate('x   {{- issue.title -}}   y').render({ issue }), 'xFix the widgety');
  });

  it('fails rendering on an unknown variable (strict mode)', () => {
    assert.throws(
      () => renderTemplate('{{ issue.missing_field }}', context),
      (error: unknown) => error instanceof Error && error.message.includes('unknown variable: issue.missing_field'),
    );
    assert.throws(
      () => renderTemplate('{{ nope }}', context),
      (error: unknown) => error instanceof Error && error.message.includes('unknown variable: nope'),
    );
    assert.throws(
      () => renderTemplate('{% if nope %}x{% endif %}', context),
      (error: unknown) => error instanceof Error && error.message.includes('unknown variable: nope'),
    );
  });

  it('fails rendering on an unknown filter', () => {
    assert.throws(
      () => renderTemplate('{{ issue.title | shout }}', context),
      (error: unknown) => error instanceof Error && error.message.includes('unknown filter: shout'),
    );
  });

  it('fails with template_parse_error on unbalanced tags', () => {
    assert.throws(
      () => parseTemplate('{% if issue.title %}no end'),
      (error: unknown) => error instanceof Error && error.name === 'TemplateError' && /unterminated/.test(error.message),
    );
    assert.throws(
      () => parseTemplate('{{ issue.title '),
      (error: unknown) => error instanceof Error && /unterminated/.test(error.message),
    );
  });

  it('caches parsed templates by source', () => {
    assert.equal(parseTemplate('same {{ issue.id }}'), parseTemplate('same {{ issue.id }}'));
  });

  it('keeps a Template instance reusable across renders', () => {
    const template = new Template('{{ issue.state }}');
    assert.equal(template.render({ issue: makeIssue({ state: 'open' }) }), 'open');
    assert.equal(template.render({ issue: makeIssue({ state: 'closed' }) }), 'closed');
  });

  it('escapes html with the escape filter', () => {
    assert.equal(renderTemplate('{{ issue.title | escape }}', { issue: makeIssue({ title: '<b>&"' }) }), '&lt;b&gt;&amp;&quot;');
  });
});
