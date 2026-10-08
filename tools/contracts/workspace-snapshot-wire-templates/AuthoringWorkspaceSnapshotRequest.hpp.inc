return value.action=="write"?value.layout.has_value()&&!value.resetConfirmationDigest:value.action=="reset"&&!value.layout&&value.resetConfirmationDigest.has_value();
