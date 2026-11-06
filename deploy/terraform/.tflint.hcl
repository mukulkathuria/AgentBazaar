# tflint --init && tflint --recursive --config "$(pwd)/.tflint.hcl"   (run from deploy/terraform)
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
