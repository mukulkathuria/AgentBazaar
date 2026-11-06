locals {
  api_host   = "api.${var.domain_name}"
  media_host = "media.${var.domain_name}"
  app_hosts  = [var.domain_name, local.api_host]

  # ALB and target group names are capped at 32 characters and may not end in a hyphen.
  alb_name  = trimsuffix(substr(var.name, 0, 32), "-")
  tg_prefix = trimsuffix(substr(var.name, 0, 28), "-")

  waf = var.enable_alb && var.enable_waf
}

data "aws_route53_zone" "this" {
  name         = coalesce(var.zone_name, var.domain_name)
  private_zone = false
}

# ---------------------------------------------------------------- certificates (DNS validated)

resource "aws_acm_certificate" "alb" {
  count                     = var.enable_alb ? 1 : 0
  domain_name               = var.domain_name
  subject_alternative_names = [local.api_host]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate" "cdn" {
  count             = var.enable_cdn ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = local.media_host
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

locals {
  # Keyed by domain (known at plan time) rather than by the certificate's computed options.
  validated_certs = merge(
    var.enable_alb ? { for d in local.app_hosts : d => aws_acm_certificate.alb[0].domain_validation_options } : {},
    var.enable_cdn ? { (local.media_host) = aws_acm_certificate.cdn[0].domain_validation_options } : {},
  )
}

resource "aws_route53_record" "validation" {
  for_each        = local.validated_certs
  zone_id         = data.aws_route53_zone.this.zone_id
  name            = one([for o in each.value : o.resource_record_name if o.domain_name == each.key])
  type            = one([for o in each.value : o.resource_record_type if o.domain_name == each.key])
  records         = [one([for o in each.value : o.resource_record_value if o.domain_name == each.key])]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "alb" {
  count                   = var.enable_alb ? 1 : 0
  certificate_arn         = aws_acm_certificate.alb[0].arn
  validation_record_fqdns = [for d in local.app_hosts : aws_route53_record.validation[d].fqdn]
}

resource "aws_acm_certificate_validation" "cdn" {
  count                   = var.enable_cdn ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.cdn[0].arn
  validation_record_fqdns = [aws_route53_record.validation[local.media_host].fqdn]
}

# ---------------------------------------------------------------- lite: DNS straight to the host

resource "aws_route53_record" "host" {
  for_each = var.enable_alb ? toset([]) : toset(local.app_hosts)
  zone_id  = data.aws_route53_zone.this.zone_id
  name     = each.key
  type     = "A"
  ttl      = 300
  records  = [var.host_ip]
}

# ---------------------------------------------------------------- growth/scale: ALB + WAF (modules/waf)

resource "aws_lb" "this" {
  count                      = var.enable_alb ? 1 : 0
  name                       = local.alb_name
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [var.alb_security_group_id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
  enable_deletion_protection = var.deletion_protection
}

# IP targets: pods are registered by the AWS Load Balancer Controller via TargetGroupBinding.
resource "aws_lb_target_group" "this" {
  for_each             = var.enable_alb ? var.app_ports : {}
  name                 = "${local.tg_prefix}-${each.key}"
  port                 = each.value
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30

  health_check {
    path                = var.health_check_paths[each.key]
    matcher             = "200-399"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  count             = var.enable_alb ? 1 : 0
  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.enable_alb ? 1 : 0
  load_balancer_arn = aws_lb.this[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.alb[0].certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["web"].arn
  }
}

# The API's Prometheus endpoint is for in-cluster scrapers only.
resource "aws_lb_listener_rule" "block_metrics" {
  count        = var.enable_alb ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 5

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }

  condition {
    path_pattern {
      values = ["/metrics", "/metrics/*"]
    }
  }
}

resource "aws_lb_listener_rule" "api" {
  count        = var.enable_alb ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["api"].arn
  }

  condition {
    host_header {
      values = [local.api_host]
    }
  }
}

module "waf" {
  source                  = "../waf"
  count                   = local.waf ? 1 : 0
  name                    = var.name
  domain_name             = var.domain_name
  alb_arn                 = aws_lb.this[0].arn
  rate_limit              = var.waf_rate_limit
  count_only_rules        = var.waf_count_only_rules
  sign_in_rate_limit      = var.waf_sign_in_rate_limit
  token_rate_limit        = var.waf_token_rate_limit
  verified_agent_cidrs    = var.waf_verified_agent_cidrs
  bot_control_level       = var.waf_bot_control_level
  bot_control_count_rules = var.waf_bot_control_count_rules
  bot_rate_limit          = var.waf_bot_rate_limit
}

# The web ACL used to live in this module.
moved {
  from = aws_wafv2_web_acl.this[0]
  to   = module.waf[0].aws_wafv2_web_acl.this
}

moved {
  from = aws_wafv2_web_acl_association.this[0]
  to   = module.waf[0].aws_wafv2_web_acl_association.this
}

resource "aws_route53_record" "alb" {
  for_each = var.enable_alb ? toset(local.app_hosts) : toset([])
  zone_id  = data.aws_route53_zone.this.zone_id
  name     = each.key
  type     = "A"

  alias {
    name                   = aws_lb.this[0].dns_name
    zone_id                = aws_lb.this[0].zone_id
    evaluate_target_health = true
  }
}

resource "aws_shield_protection" "alb" {
  count        = var.enable_alb && var.enable_shield_advanced ? 1 : 0
  name         = "${var.name}-alb"
  resource_arn = aws_lb.this[0].arn
}

# ---------------------------------------------------------------- media CDN (S3 origin via OAC)

data "aws_cloudfront_cache_policy" "optimized" {
  count = var.enable_cdn ? 1 : 0
  name  = "Managed-CachingOptimized"
}

data "aws_cloudfront_response_headers_policy" "security" {
  count = var.enable_cdn ? 1 : 0
  name  = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_origin_access_control" "media" {
  count                             = var.enable_cdn ? 1 : 0
  name                              = "${var.name}-media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "media" {
  count           = var.enable_cdn ? 1 : 0
  enabled         = true
  comment         = "${var.name} media"
  aliases         = [local.media_host]
  price_class     = var.cdn_price_class
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    origin_id                = "media"
    domain_name              = var.media_bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media[0].id
  }

  default_cache_behavior {
    target_origin_id           = "media"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized[0].id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cdn[0].certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "media" {
  count   = var.enable_cdn ? 1 : 0
  zone_id = data.aws_route53_zone.this.zone_id
  name    = local.media_host
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.media[0].domain_name
    zone_id                = aws_cloudfront_distribution.media[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_shield_protection" "cdn" {
  count        = var.enable_cdn && var.enable_shield_advanced ? 1 : 0
  name         = "${var.name}-cdn"
  resource_arn = aws_cloudfront_distribution.media[0].arn
}
