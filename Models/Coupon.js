const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
    },

    discountType: {
      type: String,
      enum: ["percentage", "flat"],
      default: "percentage",
    },

    discountValue: {
      type: Number,
      required: true,
    },

    minimumOrder: {
      type: Number,
      default: 0,
    },

    maximumDiscount: {
      type: Number,
      default: 0,
    },

    expiryDate: Date,

    active: {
      type: Boolean,
      default: true,
    },

    usageCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    maxUses: {
      type: Number,
      min: 1,
      default: null,
    },

    // Referral wallet linkage: when set, every successful order that uses
    // this coupon adds `referralBonus` to this user's wallet balance and
    // emails them that their code was used. The buyer still gets the normal
    // discount above — this is on top of that, not instead of it.
    assignedUserEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    referralBonus: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Coupon", couponSchema);