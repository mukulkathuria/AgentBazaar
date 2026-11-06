# Bot management at the scale edge (modules/waf): Bot Control on the storefront host only, rate-based rules (per IP,
# sign-in, per bearer token, per unverified bot) and the verified-agent allow-list. Mocked AWS only.

mock_provider "aws" {
  mock_resource "aws_wafv2_web_acl" { defaults = { arn = "arn:aws:wafv2:ap-south-1:123456789012:regional/webacl/mock/00000000-0000-0000-0000-000000000000" } }
  mock_resource "aws_wafv2_ip_set" { defaults = { arn = "arn:aws:wafv2:ap-south-1:123456789012:regional/ipset/mock/00000000-0000-0000-0000-000000000000" } }
}

# The edge module's defaults (modules/edge/variables.tf), with Bot Control and the allow-list off.
variables {
  name                    = "acme-prod-aps1"
  domain_name             = "shop.example.com"
  alb_arn                 = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:loadbalancer/app/mock/0123456789abcdef"
  rate_limit              = 2000
  count_only_rules        = ["SizeRestrictions_BODY"]
  sign_in_rate_limit      = 100
  token_rate_limit        = 60000
  verified_agent_cidrs    = []
  bot_control_level       = null
  bot_control_count_rules = ["CategoryAI", "CategoryHttpLibrary", "SignalNonBrowserUserAgent", "SignalKnownBotDataCenter"]
  bot_rate_limit          = 600
}

run "bot_control_guards_the_storefront_and_spares_agents" {
  command = plan

  module {
    source = "../../modules/waf"
  }

  variables {
    bot_control_level    = "COMMON"
    verified_agent_cidrs = ["203.0.113.0/24"]
  }

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.this.rule : r.statement[0].managed_rule_group_statement[0].managed_rule_group_configs[0].aws_managed_rules_bot_control_rule_set[0].inspection_level
      if r.name == "AWSManagedRulesBotControlRuleSet"
    ]) == "COMMON"
    error_message = "Bot Control must run at the requested inspection level."
  }

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.this.rule : r.statement[0].managed_rule_group_statement[0].scope_down_statement[0].byte_match_statement[0].search_string
      if r.name == "AWSManagedRulesBotControlRuleSet"
    ]) == "shop.example.com"
    error_message = "Bot Control must be scoped down to the storefront host: the API serves agents by design."
  }

  assert {
    condition = toset([
      for o in one([for r in aws_wafv2_web_acl.this.rule : r.statement[0].managed_rule_group_statement[0].rule_action_override if r.name == "AWSManagedRulesBotControlRuleSet"]) : o.name
      if length(o.action_to_use[0].count) == 1
    ]) == toset(["CategoryAI", "CategoryHttpLibrary", "SignalNonBrowserUserAgent", "SignalKnownBotDataCenter"])
    error_message = "AI crawlers and agents' HTTP clients must be counted (then throttled), not blocked."
  }

  assert {
    condition     = contains(output.managed_rule_groups, "AWSManagedRulesBotControlRuleSet")
    error_message = "The managed rule group list must show Bot Control when it is on."
  }

  assert {
    condition     = toset(aws_wafv2_ip_set.verified_agents[0].addresses) == toset(["203.0.113.0/24"]) && aws_wafv2_ip_set.verified_agents[0].ip_address_version == "IPV4"
    error_message = "Verified agent CIDRs must become an IPv4 IP set."
  }

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.this.rule : length(r.action[0].count) == 1 && one(r.rule_label).name == "agentbazaar:verified-agent"
      if r.name == "VerifiedAgents"
    ])
    error_message = "Verified agents must be labelled with a count action, so every later rule still sees them."
  }

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.this.rule : r.statement[0].rate_based_statement[0].scope_down_statement[0].not_statement[0].statement[0].label_match_statement[0].key
      if r.name == "RateLimitPerIp"
    ]) == "agentbazaar:verified-agent"
    error_message = "The per-IP rate limit must skip verified agents."
  }

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.this.rule : r.statement[0].rate_based_statement[0].custom_key[0].header[0].name
      if r.name == "RateLimitPerToken"
    ]) == "authorization"
    error_message = "The per-token limit must aggregate on the Authorization header."
  }

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.this.rule : r.statement[0].rate_based_statement[0].scope_down_statement[0].regex_match_statement[0].regex_string
      if r.name == "RateLimitSignIn"
    ]) == "^/(api/v1/auth/login|oauth/token)"
    error_message = "The sign-in limit must cover customer login and the agent token endpoint."
  }

  assert {
    condition = one([
      for r in aws_wafv2_web_acl.this.rule : r.statement[0].rate_based_statement[0].custom_key[0].label_namespace[0].namespace
      if r.name == "RateLimitBots"
    ]) == "awswaf:managed:aws:bot-control:bot:name:"
    error_message = "Unverified bots must be throttled per bot name (and IP)."
  }

  assert {
    condition = alltrue([
      for r in aws_wafv2_web_acl.this.rule : r.action[0].block[0].custom_response[0].response_code == 429
      if startswith(r.name, "RateLimit")
    ])
    error_message = "Rate rules must answer 429 so agents back off."
  }

  assert {
    condition = (
      one([for r in aws_wafv2_web_acl.this.rule : r.priority if r.name == "VerifiedAgents"]) <
      one([for r in aws_wafv2_web_acl.this.rule : r.priority if r.name == "RateLimitPerIp"]) &&
      one([for r in aws_wafv2_web_acl.this.rule : r.priority if r.name == "AWSManagedRulesBotControlRuleSet"]) <
      one([for r in aws_wafv2_web_acl.this.rule : r.priority if r.name == "RateLimitBots"])
    )
    error_message = "Labels must be added before the rules that read them."
  }

  assert {
    condition     = length(aws_wafv2_web_acl.this.rule) == length(distinct([for r in aws_wafv2_web_acl.this.rule : r.priority]))
    error_message = "Rule priorities must be unique."
  }
}

run "bot_control_and_allow_list_are_opt_in" {
  command = plan

  module {
    source = "../../modules/waf"
  }

  assert {
    condition     = length([for r in aws_wafv2_web_acl.this.rule : r if contains(["AWSManagedRulesBotControlRuleSet", "RateLimitBots", "VerifiedAgents"], r.name)]) == 0
    error_message = "Without a level or CIDRs the module must not add Bot Control, the bot limit or the allow-list."
  }

  assert {
    condition     = length(aws_wafv2_ip_set.verified_agents) == 0
    error_message = "No IP set without verified agent CIDRs."
  }

  assert {
    condition     = toset([for r in aws_wafv2_web_acl.this.rule : r.name if startswith(r.name, "RateLimit")]) == toset(["RateLimitPerIp", "RateLimitSignIn", "RateLimitPerToken"])
    error_message = "Growth and scale keep the per-IP, sign-in and per-token rate rules by default."
  }
}

run "rejects_an_ipv6_or_malformed_allow_list" {
  command = plan

  module {
    source = "../../modules/waf"
  }

  variables {
    verified_agent_cidrs = ["2001:db8::/32", "not-a-cidr"]
  }

  expect_failures = [var.verified_agent_cidrs]
}

run "rejects_an_unknown_inspection_level" {
  command = plan

  module {
    source = "../../modules/waf"
  }

  variables {
    bot_control_level = "PARANOID"
  }

  expect_failures = [var.bot_control_level]
}
