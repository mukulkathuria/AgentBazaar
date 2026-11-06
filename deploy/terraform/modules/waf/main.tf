# AWS WAF web ACL for the ALB (growth/scale): AWS managed rule groups, rate-based rules (per IP, sign-in, per bearer
# token, per unverified bot), Bot Control on the storefront host and an allow-list for verified agent clients.

locals {
  rule_groups     = ["AWSManagedRulesCommonRuleSet", "AWSManagedRulesKnownBadInputsRuleSet", "AWSManagedRulesAmazonIpReputationList"]
  bot_control     = var.bot_control_level != null
  verified_agents = length(var.verified_agent_cidrs) > 0
  verified_label  = "agentbazaar:verified-agent"
}

# Partner agents' egress addresses: labelled first, then exempt from the per-IP rate limit (they keep their
# per-token limit, the managed rule groups and the API's own per-agent quota).
resource "aws_wafv2_ip_set" "verified_agents" {
  count              = local.verified_agents ? 1 : 0
  name               = "${var.name}-verified-agents"
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = var.verified_agent_cidrs
}

resource "aws_wafv2_web_acl" "this" {
  name  = var.name
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = aws_wafv2_ip_set.verified_agents
    content {
      name     = "VerifiedAgents"
      priority = 0

      action {
        count {}
      }

      rule_label {
        name = local.verified_label
      }

      statement {
        ip_set_reference_statement {
          arn = rule.value.arn
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "VerifiedAgents"
        sampled_requests_enabled   = true
      }
    }
  }

  dynamic "rule" {
    for_each = var.rate_limit > 0 ? [var.rate_limit] : []
    content {
      name     = "RateLimitPerIp"
      priority = 1

      action {
        block {
          custom_response {
            response_code = 429
          }
        }
      }

      statement {
        rate_based_statement {
          limit              = rule.value
          aggregate_key_type = "IP"

          dynamic "scope_down_statement" {
            for_each = local.verified_agents ? [1] : []
            content {
              not_statement {
                statement {
                  label_match_statement {
                    scope = "LABEL"
                    key   = local.verified_label
                  }
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "RateLimitPerIp"
        sampled_requests_enabled   = true
      }
    }
  }

  # Credential stuffing and client-secret guessing, on top of the API's per-account lockout.
  dynamic "rule" {
    for_each = var.sign_in_rate_limit > 0 ? [var.sign_in_rate_limit] : []
    content {
      name     = "RateLimitSignIn"
      priority = 2

      action {
        block {
          custom_response {
            response_code = 429
          }
        }
      }

      statement {
        rate_based_statement {
          limit              = rule.value
          aggregate_key_type = "IP"

          scope_down_statement {
            regex_match_statement {
              regex_string = "^/(api/v1/auth/login|oauth/token)"

              field_to_match {
                uri_path {}
              }

              text_transformation {
                priority = 0
                type     = "LOWERCASE"
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "RateLimitSignIn"
        sampled_requests_enabled   = true
      }
    }
  }

  # Edge backstop for per-agent quotas: one bucket per bearer token. Requests without the header are not counted.
  dynamic "rule" {
    for_each = var.token_rate_limit > 0 ? [var.token_rate_limit] : []
    content {
      name     = "RateLimitPerToken"
      priority = 3

      action {
        block {
          custom_response {
            response_code = 429
          }
        }
      }

      statement {
        rate_based_statement {
          limit              = rule.value
          aggregate_key_type = "CUSTOM_KEYS"

          custom_key {
            header {
              name = "authorization"

              text_transformation {
                priority = 0
                type     = "NONE"
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "RateLimitPerToken"
        sampled_requests_enabled   = true
      }
    }
  }

  # Bot Control labels and blocks unverified bots on the storefront only: the API serves agents by design, so
  # the rate rules above and the API's per-agent quotas govern them there.
  dynamic "rule" {
    for_each = local.bot_control ? [var.bot_control_level] : []
    content {
      name     = "AWSManagedRulesBotControlRuleSet"
      priority = 20

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = "AWSManagedRulesBotControlRuleSet"
          vendor_name = "AWS"

          managed_rule_group_configs {
            aws_managed_rules_bot_control_rule_set {
              inspection_level = rule.value
            }
          }

          dynamic "rule_action_override" {
            for_each = var.bot_control_count_rules
            content {
              name = rule_action_override.value

              action_to_use {
                count {}
              }
            }
          }

          scope_down_statement {
            byte_match_statement {
              search_string         = lower(var.domain_name)
              positional_constraint = "EXACTLY"

              field_to_match {
                single_header {
                  name = "host"
                }
              }

              text_transformation {
                priority = 0
                type     = "LOWERCASE"
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "AWSManagedRulesBotControlRuleSet"
        sampled_requests_enabled   = true
      }
    }
  }

  # Bots the rule above only counts (AI crawlers, HTTP libraries) are throttled per bot name and address instead.
  dynamic "rule" {
    for_each = local.bot_control && var.bot_rate_limit > 0 ? [var.bot_rate_limit] : []
    content {
      name     = "RateLimitBots"
      priority = 21

      action {
        block {
          custom_response {
            response_code = 429
          }
        }
      }

      statement {
        rate_based_statement {
          limit              = rule.value
          aggregate_key_type = "CUSTOM_KEYS"

          custom_key {
            label_namespace {
              namespace = "awswaf:managed:aws:bot-control:bot:name:"
            }
          }

          custom_key {
            ip {}
          }

          scope_down_statement {
            not_statement {
              statement {
                label_match_statement {
                  scope = "LABEL"
                  key   = "awswaf:managed:aws:bot-control:bot:verified"
                }
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "RateLimitBots"
        sampled_requests_enabled   = true
      }
    }
  }

  dynamic "rule" {
    for_each = local.rule_groups
    content {
      name     = rule.value
      priority = rule.key + 10

      override_action {
        none {}
      }

      statement {
        managed_rule_group_statement {
          name        = rule.value
          vendor_name = "AWS"

          dynamic "rule_action_override" {
            for_each = rule.value == "AWSManagedRulesCommonRuleSet" ? var.count_only_rules : []
            content {
              name = rule_action_override.value

              action_to_use {
                count {}
              }
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.value
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = var.name
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}
