require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Razorpay = require("razorpay");

const app = express();
const PORT = process.env.PORT || 5000;
const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
const jwtSecret = process.env.JWT_SECRET;
const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
const razorpayKeySecret = String(
  process.env.RAZORPAY_KEY_SECRET || ""
).trim();
const razorpayWebhookSecret = String(
  process.env.RAZORPAY_WEBHOOK_SECRET || ""
).trim();
const razorpay =
  razorpayKeyId && razorpayKeySecret
    ? new Razorpay({
        key_id: razorpayKeyId,
        key_secret: razorpayKeySecret,
      })
    : null;

if (
  !process.env.MONGODB_URI ||
  !jwtSecret ||
  !process.env.ADMIN_EMAIL ||
  !process.env.ADMIN_PASSWORD_HASH
) {
  throw new Error(
    "Missing MONGODB_URI, JWT_SECRET, ADMIN_EMAIL, or ADMIN_PASSWORD_HASH environment variable"
  );
}

app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin: clientUrl,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  })
);
app.use(
  "/api/payments/razorpay/webhook",
  express.raw({ type: "application/json", limit: "100kb" })
);
app.use(express.json({ limit: "100kb" }));

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes.",
  },
});

const customerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please try again after 15 minutes.",
  },
});

const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many payment attempts. Please try again later.",
  },
});

const allowedCategories = [
  "Skincare",
  "Makeup",
  "Haircare",
  "Fragrance",
  "Bath & Body",
];

const allowedDealTypes = ["none", "99", "199"];

const orderStatuses = [
  "placed",
  "confirmed",
  "packed",
  "shipped",
  "delivered",
  "cancelled",
];

const productSchema = new mongoose.Schema(
  {
    brand: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    category: {
      type: String,
      required: true,
      enum: allowedCategories,
    },
    price: { type: Number, required: true, min: 0 },
    mrp: { type: Number, required: true, min: 0 },
    rating: { type: Number, default: 4.5, min: 0, max: 5 },
    reviews: { type: Number, default: 0, min: 0 },
    image: { type: String, default: "" },
    badge: { type: String, default: "" },
    stock: { type: Number, default: 20, min: 0 },
    isFeatured: { type: Boolean, default: false },
    dealType: {
      type: String,
      enum: allowedDealTypes,
      default: "none",
      index: true,
    },
    marketplaceLinks: [
      {
        platform: { type: String, trim: true },
        url: { type: String, trim: true },
      },
    ],
  },
  { timestamps: true }
);

const orderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    customer: {
      name: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true },
      address: { type: String, required: true, trim: true },
      city: { type: String, required: true, trim: true },
      pincode: { type: String, required: true, trim: true },
    },
    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        brand: { type: String, default: "" },
        title: { type: String, required: true },
        image: { type: String, default: "" },
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
        subtotal: { type: Number, required: true, min: 0 },
      },
    ],
    deliveryFee: { type: Number, default: 0, min: 0 },
    couponCode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    deliveryType: {
      type: String,
      enum: ["local", "courier"],
      default: "courier",
    },
    paymentMethod: {
      type: String,
      enum: ["cod", "razorpay"],
      default: "cod",
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },
    razorpayOrderId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    razorpaySignature: {
      type: String,
      default: "",
      trim: true,
    },
    paymentCapturedAt: {
      type: Date,
      default: null,
    },
    orderStatus: {
      type: String,
      enum: orderStatuses,
      default: "placed",
    },
    stockRestored: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const paymentSessionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    customer: {
      name: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true },
      address: { type: String, required: true, trim: true },
      city: { type: String, required: true, trim: true },
      pincode: { type: String, required: true, trim: true },
    },
    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        brand: { type: String, default: "" },
        title: { type: String, required: true },
        image: { type: String, default: "" },
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
        subtotal: { type: Number, required: true, min: 0 },
      },
    ],
    deliveryFee: { type: Number, default: 0, min: 0 },
    couponCode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },
    discountAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    amountInPaise: { type: Number, required: true, min: 1 },
    deliveryType: {
      type: String,
      enum: ["local", "courier"],
      required: true,
    },
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["created", "paid", "refund_pending", "refunded", "failed"],
      default: "created",
      index: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    refundId: {
      type: String,
      default: "",
      trim: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },
  },
  { timestamps: true }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true, select: false },
    phone: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    city: { type: String, default: "Kanpur", trim: true },
    pincode: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

const Product = mongoose.model("Product", productSchema);
const Order = mongoose.model("Order", orderSchema);
const PaymentSession = mongoose.model(
  "PaymentSession",
  paymentSessionSchema
);
const User = mongoose.model("User", userSchema);

const readBearerToken = (req) =>
  req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : "";

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  address: user.address,
  city: user.city,
  pincode: user.pincode,
});

const requireAdmin = (req, res, next) => {
  const token = readBearerToken(req);

  try {
    const payload = jwt.verify(token, jwtSecret);

    if (payload.role !== "admin") {
      throw new Error("Invalid role");
    }

    req.admin = payload;
    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Please log in as an admin.",
    });
  }
};

const requireUser = (req, res, next) => {
  try {
    const payload = jwt.verify(readBearerToken(req), jwtSecret);

    if (payload.role !== "user" || !payload.userId) {
      throw new Error("Invalid role");
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({
      success: false,
      message: "Please log in to your customer account.",
    });
  }
};

const optionalUser = (req, _res, next) => {
  const token = readBearerToken(req);

  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload.role === "user" && payload.userId) req.user = payload;
    } catch {
      req.user = null;
    }
  }

  next();
};

const sanitizeMarketplaceLinks = (links) => {
  if (!Array.isArray(links)) return [];

  return links
    .map((link) => ({
      platform: String(link?.platform || "").trim(),
      url: String(link?.url || "").trim(),
    }))
    .filter(({ platform, url }) => platform && /^https:\/\//i.test(url))
    .slice(0, 3);
};

const validateProduct = ({
  brand,
  title,
  category,
  price,
  mrp,
  dealType = "none",
}) => {
  const normalizedDealType = String(dealType);
  const effectivePrice =
    normalizedDealType === "none" ? Number(price) : Number(normalizedDealType);

  if (!brand || !title || !category || price === "" || mrp === "") {
    return "Brand, title, category, price and MRP are required";
  }

  if (!allowedCategories.includes(category)) {
    return "Please choose a valid category";
  }

  if (!allowedDealTypes.includes(normalizedDealType)) {
    return "Please choose a valid deal section";
  }

  if (
    !Number.isFinite(effectivePrice) ||
    !Number.isFinite(Number(mrp)) ||
    effectivePrice < 0 ||
    Number(mrp) < 0
  ) {
    return "Price and MRP must be valid positive numbers";
  }

  if (Number(mrp) < effectivePrice) {
    return "MRP cannot be lower than selling price";
  }

  return null;
};

const productPayload = (body) => {
  const dealType = allowedDealTypes.includes(String(body.dealType))
    ? String(body.dealType)
    : "none";

  return {
    ...body,
    dealType,
    price: dealType === "none" ? Number(body.price) : Number(dealType),
    mrp: Number(body.mrp),
    rating: Number(body.rating || 4.5),
    reviews: Number(body.reviews || 0),
    stock: Number(body.stock || 0),
    isFeatured: Boolean(body.isFeatured),
    marketplaceLinks: sanitizeMarketplaceLinks(body.marketplaceLinks),
  };
};

const createOrderNumber = () =>
  `DR-${Date.now()}-${crypto.randomInt(1000, 10000)}`;

const getRazorpay = () => {
  if (!razorpay) {
    const error = new Error(
      "Online payment is not configured. Please choose Cash on Delivery."
    );
    error.statusCode = 503;
    throw error;
  }

  return razorpay;
};

const cleanDeliveryCustomer = (customer) => ({
  name: String(customer?.name || "").trim(),
  phone: String(customer?.phone || "").replace(/\D/g, ""),
  address: String(customer?.address || "").trim(),
  city: String(customer?.city || "").trim(),
  pincode: String(customer?.pincode || "").replace(/\D/g, ""),
});

const validateDeliveryCustomer = (customer) => {
  if (
    !customer.name ||
    !customer.address ||
    !customer.city ||
    customer.phone.length !== 10 ||
    customer.pincode.length !== 6
  ) {
    throw new Error("Please enter valid delivery details");
  }
};

const normaliseCouponCode = (couponCode) =>
  String(couponCode || "").trim().toUpperCase();

const roundMoney = (amount) =>
  Math.round((Number(amount) + Number.EPSILON) * 100) / 100;

const buildOnlinePaymentQuote = async ({
  customer,
  items,
  couponCode,
}) => {
  const cleanCustomer = cleanDeliveryCustomer(customer);
  validateDeliveryCustomer(cleanCustomer);

  if (!Array.isArray(items) || !items.length) {
    throw new Error("Your cart is empty");
  }

  const requestedProducts = new Map();

  for (const item of items) {
    const productId = String(item?.productId || "");
    const quantity = Number(item?.quantity);

    if (
      !mongoose.Types.ObjectId.isValid(productId) ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      throw new Error("Invalid product or quantity in cart");
    }

    requestedProducts.set(
      productId,
      (requestedProducts.get(productId) || 0) + quantity
    );
  }

  const orderItems = [];
  let subtotal = 0;

  for (const [productId, quantity] of requestedProducts.entries()) {
    const product = await Product.findById(productId);

    if (!product || product.stock < quantity) {
      throw new Error(
        "A product is unavailable or does not have enough stock"
      );
    }

    const lineTotal = roundMoney(product.price * quantity);
    subtotal = roundMoney(subtotal + lineTotal);

    orderItems.push({
      product: product._id,
      brand: product.brand,
      title: product.title,
      image: product.image,
      price: product.price,
      quantity,
      subtotal: lineTotal,
    });
  }

  const normalizedCoupon = normaliseCouponCode(couponCode);

  if (normalizedCoupon && normalizedCoupon !== "WELCOME10") {
    throw new Error("Invalid coupon code");
  }

  let discountAmount = 0;

  if (normalizedCoupon === "WELCOME10") {
    if (subtotal <= 499) {
      throw new Error(
        "WELCOME10 applies only when the cart subtotal is above â‚¹499"
      );
    }

    discountAmount = Math.round(subtotal * 0.1);
  }

  const normalizedCity = cleanCustomer.city
    .toLowerCase()
    .replace(/\s+/g, " ");
  const isKanpurAddress = normalizedCity.includes("kanpur");
  const deliveryFee =
    subtotal >= 499 ? 0 : isKanpurAddress ? 29 : 49;
  const totalAmount = roundMoney(
    subtotal - discountAmount + deliveryFee
  );
  const amountInPaise = Math.round(totalAmount * 100);

  if (amountInPaise < 1) {
    throw new Error("Order total must be greater than zero");
  }

  return {
    cleanCustomer,
    orderItems,
    subtotal,
    deliveryFee,
    couponCode: normalizedCoupon,
    discountAmount,
    totalAmount,
    amountInPaise,
    deliveryType: isKanpurAddress ? "local" : "courier",
  };
};

const signaturesMatch = (received, expected) => {
  const receivedBuffer = Buffer.from(String(received || ""), "utf8");
  const expectedBuffer = Buffer.from(String(expected || ""), "utf8");

  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
};

const getCapturedRazorpayPayment = async ({
  razorpayOrderId,
  razorpayPaymentId,
  amountInPaise,
}) => {
  const instance = getRazorpay();
  let payment = await instance.payments.fetch(razorpayPaymentId);

  if (
    payment.order_id !== razorpayOrderId ||
    Number(payment.amount) !== Number(amountInPaise) ||
    String(payment.currency).toUpperCase() !== "INR"
  ) {
    const error = new Error("Payment details do not match this order");
    error.statusCode = 400;
    throw error;
  }

  if (payment.status === "authorized") {
    payment = await instance.payments.capture(
      razorpayPaymentId,
      amountInPaise,
      "INR"
    );
  }

  if (payment.status !== "captured" || payment.captured !== true) {
    const error = new Error(
      "Payment has not been captured. Please do not retry payment yet."
    );
    error.statusCode = 409;
    throw error;
  }

  return payment;
};

const finaliseRazorpayPayment = async ({
  paymentSessionRecord,
  payment,
  razorpaySignature = "",
}) => {
  if (
    paymentSessionRecord.status === "paid" &&
    paymentSessionRecord.order
  ) {
    return Order.findById(paymentSessionRecord.order);
  }

  const databaseSession = await mongoose.startSession();
  let completedOrder = null;

  try {
    await databaseSession.withTransaction(async () => {
      const currentPaymentSession = await PaymentSession.findById(
        paymentSessionRecord._id
      ).session(databaseSession);

      if (!currentPaymentSession) {
        throw new Error("Payment session not found");
      }

      if (
        currentPaymentSession.status === "paid" &&
        currentPaymentSession.order
      ) {
        completedOrder = await Order.findById(
          currentPaymentSession.order
        ).session(databaseSession);
        return;
      }

      if (
        ["refund_pending", "refunded"].includes(
          currentPaymentSession.status
        )
      ) {
        const error = new Error(
          "This payment is already being refunded"
        );
        error.statusCode = 409;
        error.code = "PAYMENT_REFUND_IN_PROGRESS";
        throw error;
      }

      for (const item of currentPaymentSession.items) {
        const stockUpdate = await Product.updateOne(
          {
            _id: item.product,
            stock: { $gte: item.quantity },
          },
          { $inc: { stock: -item.quantity } },
          { session: databaseSession }
        );

        if (stockUpdate.modifiedCount !== 1) {
          const error = new Error(
            "A product sold out while payment was processing"
          );
          error.code = "OUT_OF_STOCK_AFTER_PAYMENT";
          throw error;
        }
      }

      [completedOrder] = await Order.create(
        [
          {
            orderNumber: currentPaymentSession.orderNumber,
            user: currentPaymentSession.user,
            customer: currentPaymentSession.customer,
            items: currentPaymentSession.items,
            deliveryFee: currentPaymentSession.deliveryFee,
            couponCode: currentPaymentSession.couponCode,
            discountAmount: currentPaymentSession.discountAmount,
            totalAmount: currentPaymentSession.totalAmount,
            deliveryType: currentPaymentSession.deliveryType,
            paymentMethod: "razorpay",
            paymentStatus: "paid",
            razorpayOrderId: currentPaymentSession.razorpayOrderId,
            razorpayPaymentId: payment.id,
            razorpaySignature,
            paymentCapturedAt: new Date(),
          },
        ],
        { session: databaseSession }
      );

      currentPaymentSession.status = "paid";
      currentPaymentSession.razorpayPaymentId = payment.id;
      currentPaymentSession.order = completedOrder._id;
      await currentPaymentSession.save({ session: databaseSession });

      if (currentPaymentSession.user) {
        await User.findByIdAndUpdate(
          currentPaymentSession.user,
          { $set: currentPaymentSession.customer },
          { session: databaseSession, runValidators: true }
        );
      }
    });

    return completedOrder;
  } catch (error) {
    const completedSession = await PaymentSession.findById(
      paymentSessionRecord._id
    );

    if (completedSession?.status === "paid" && completedSession.order) {
      return Order.findById(completedSession.order);
    }

    if (error.code !== "OUT_OF_STOCK_AFTER_PAYMENT") {
      throw error;
    }

    const refundClaim = await PaymentSession.findOneAndUpdate(
      {
        _id: paymentSessionRecord._id,
        status: "created",
      },
      {
        $set: {
          status: "refund_pending",
          razorpayPaymentId: payment.id,
        },
      },
      { new: true }
    );

    if (refundClaim) {
      try {
        const refund = await getRazorpay().payments.refund(payment.id, {
          amount: paymentSessionRecord.amountInPaise,
          speed: "normal",
          receipt: `RF-${paymentSessionRecord.orderNumber}`,
          notes: {
            reason: "Product became unavailable during payment",
          },
        });

        await PaymentSession.findByIdAndUpdate(paymentSessionRecord._id, {
          status: "refunded",
          refundId: refund.id,
        });
      } catch (refundError) {
        console.error(
          "Automatic Razorpay refund failed:",
          refundError.message
        );
      }
    }

    const refundState = await PaymentSession.findById(
      paymentSessionRecord._id
    );
    const refundStarted = refundState?.status === "refunded";
    const refundError = new Error(
      refundStarted
        ? "A product sold out during payment. A full refund has been initiated."
        : "Payment succeeded, but the order needs manual review. Please contact DEALROOT with the payment ID."
    );
    refundError.statusCode = 409;
    refundError.code = refundStarted
      ? "PAYMENT_REFUNDED"
      : "PAYMENT_REVIEW_REQUIRED";
    throw refundError;
  } finally {
    await databaseSession.endSession();
  }
};

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "DEALROOT backend is running",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "dealroot-backend",
    database:
      mongoose.connection.readyState === 1 ? "connected" : "not connected",
  });
});

app.post("/api/admin/login", adminLoginLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  const normaliseForComparison = (value) =>
    Buffer.from(String(value).slice(0, 256).padEnd(256));

  const isCorrectEmail = crypto.timingSafeEqual(
    normaliseForComparison(email),
    normaliseForComparison(
      String(process.env.ADMIN_EMAIL).toLowerCase()
    )
  );

  const isCorrectPassword = await bcrypt.compare(
    password,
    process.env.ADMIN_PASSWORD_HASH
  );

  if (!isCorrectEmail || !isCorrectPassword) {
    return res.status(401).json({
      success: false,
      message: "Invalid email or password",
    });
  }

  const token = jwt.sign(
    { role: "admin", email },
    jwtSecret,
    { expiresIn: "8h" }
  );

  res.json({
    success: true,
    token,
    admin: { email },
  });
});

app.post("/api/auth/signup", customerAuthLimiter, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (name.length < 2) {
      return res.status(400).json({ success: false, message: "Please enter your full name" });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address" });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    if (await User.exists({ email })) {
      return res.status(409).json({ success: false, message: "An account with this email already exists" });
    }

    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
    });
    const token = jwt.sign({ role: "user", userId: user._id }, jwtSecret, { expiresIn: "7d" });

    res.status(201).json({ success: true, token, user: publicUser(user) });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: "An account with this email already exists" });
    }
    res.status(500).json({ success: false, message: "Could not create your account" });
  }
});

app.post("/api/auth/login", customerAuthLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const user = await User.findOne({ email }).select("+passwordHash");

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const token = jwt.sign({ role: "user", userId: user._id }, jwtSecret, { expiresIn: "7d" });
    res.json({ success: true, token, user: publicUser(user) });
  } catch {
    res.status(500).json({ success: false, message: "Could not log in" });
  }
});

app.get("/api/auth/me", requireUser, async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user) return res.status(404).json({ success: false, message: "Account not found" });
  res.json({ success: true, user: publicUser(user) });
});

app.put("/api/auth/me", requireUser, async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const pincode = String(req.body?.pincode || "").replace(/\D/g, "");
    const update = {
      name: String(req.body?.name || "").trim(),
      phone,
      address: String(req.body?.address || "").trim(),
      city: String(req.body?.city || "").trim(),
      pincode,
    };

    if (update.name.length < 2) throw new Error("Please enter your full name");
    if (phone && phone.length !== 10) throw new Error("Please enter a valid 10-digit mobile number");
    if (pincode && pincode.length !== 6) throw new Error("Please enter a valid 6-digit pincode");

    const user = await User.findByIdAndUpdate(req.user.userId, update, {
      new: true,
      runValidators: true,
    });
    if (!user) return res.status(404).json({ success: false, message: "Account not found" });
    res.json({ success: true, user: publicUser(user) });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || "Could not save profile" });
  }
});

app.get("/api/auth/orders", requireUser, async (req, res) => {
  const orders = await Order.find({ user: req.user.userId }).sort({ createdAt: -1 });
  res.json({ success: true, count: orders.length, orders });
});

app.get("/api/products", async (req, res) => {
  try {
    const { category, search, featured, dealType } = req.query;
    const filter = {};

    if (category && category !== "All") {
      filter.category = category;
    }

    if (featured === "true") {
      filter.isFeatured = true;
    }

    if (dealType && dealType !== "none") {
      if (!allowedDealTypes.includes(String(dealType))) {
        return res.status(400).json({
          success: false,
          message: "Please choose a valid deal section",
        });
      }

      filter.dealType = String(dealType);
    }

    if (search) {
      filter.$or = ["title", "brand", "category"].map((key) => ({
        [key]: {
          $regex: String(search),
          $options: "i",
        },
      }));
    }

    const products = await Product.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: products.length,
      products,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not load products",
    });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({ success: true, product });
  } catch {
    res.status(400).json({
      success: false,
      message: "Invalid product id",
    });
  }
});

app.post("/api/products", requireAdmin, async (req, res) => {
  try {
    const error = validateProduct(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error,
      });
    }

    const product = await Product.create(productPayload(req.body));

    res.status(201).json({
      success: true,
      message: "Product added successfully",
      product,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not add product",
    });
  }
});

app.put("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const error = validateProduct(req.body);

    if (error) {
      return res.status(400).json({
        success: false,
        message: error,
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      productPayload(req.body),
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Product updated successfully",
      product,
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not update product",
    });
  }
});

app.patch("/api/products/:id/stock", requireAdmin, async (req, res) => {
  try {
    const stock = Number(req.body.stock);

    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({
        success: false,
        message: "Stock must be a whole positive number",
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { stock },
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Stock updated successfully",
      product,
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not update stock",
    });
  }
});

app.delete("/api/products/:id", requireAdmin, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    res.json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not delete product",
    });
  }
});

app.post(
  "/api/payments/razorpay/create-order",
  paymentLimiter,
  optionalUser,
  async (req, res) => {
    try {
      const instance = getRazorpay();
      const quote = await buildOnlinePaymentQuote(req.body);
      const orderNumber = createOrderNumber();

      const razorpayOrder = await instance.orders.create({
        amount: quote.amountInPaise,
        currency: "INR",
        receipt: orderNumber,
        notes: {
          dealroot_order_number: orderNumber,
        },
      });

      const paymentSession = await PaymentSession.create({
        user: req.user?.userId || null,
        orderNumber,
        customer: quote.cleanCustomer,
        items: quote.orderItems,
        deliveryFee: quote.deliveryFee,
        couponCode: quote.couponCode,
        discountAmount: quote.discountAmount,
        totalAmount: quote.totalAmount,
        amountInPaise: quote.amountInPaise,
        deliveryType: quote.deliveryType,
        razorpayOrderId: razorpayOrder.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      if (req.user?.userId) {
        await User.findByIdAndUpdate(
          req.user.userId,
          { $set: quote.cleanCustomer },
          { runValidators: true }
        );
      }

      res.status(201).json({
        success: true,
        keyId: razorpayKeyId,
        paymentSessionId: paymentSession._id,
        razorpayOrderId: razorpayOrder.id,
        orderNumber,
        amount: quote.amountInPaise,
        currency: "INR",
      });
    } catch (error) {
      console.error(
        "Razorpay order creation failed:",
        error.error?.description || error.message
      );

      res.status(error.statusCode || 400).json({
        success: false,
        message:
          error.error?.description ||
          error.message ||
          "Could not start online payment",
      });
    }
  }
);

app.post(
  "/api/payments/razorpay/verify",
  paymentLimiter,
  optionalUser,
  async (req, res) => {
    try {
      getRazorpay();

      const paymentSessionId = String(
        req.body?.paymentSessionId || ""
      );
      const razorpayOrderId = String(
        req.body?.razorpayOrderId || ""
      );
      const razorpayPaymentId = String(
        req.body?.razorpayPaymentId || ""
      );
      const razorpaySignature = String(
        req.body?.razorpaySignature || ""
      );

      if (
        !mongoose.Types.ObjectId.isValid(paymentSessionId) ||
        !razorpayOrderId ||
        !razorpayPaymentId ||
        !razorpaySignature
      ) {
        throw new Error("Incomplete payment verification details");
      }

      const paymentSessionRecord = await PaymentSession.findOne({
        _id: paymentSessionId,
        razorpayOrderId,
      });

      if (!paymentSessionRecord) {
        const error = new Error("Payment session not found");
        error.statusCode = 404;
        throw error;
      }

      const expectedSignature = crypto
        .createHmac("sha256", razorpayKeySecret)
        .update(
          `${paymentSessionRecord.razorpayOrderId}|${razorpayPaymentId}`
        )
        .digest("hex");

      if (!signaturesMatch(razorpaySignature, expectedSignature)) {
        const error = new Error("Payment signature verification failed");
        error.statusCode = 400;
        throw error;
      }

      const payment = await getCapturedRazorpayPayment({
        razorpayOrderId: paymentSessionRecord.razorpayOrderId,
        razorpayPaymentId,
        amountInPaise: paymentSessionRecord.amountInPaise,
      });

      const order = await finaliseRazorpayPayment({
        paymentSessionRecord,
        payment,
        razorpaySignature,
      });

      res.status(201).json({
        success: true,
        message: "Payment verified and order confirmed",
        order,
      });
    } catch (error) {
      console.error(
        "Razorpay verification failed:",
        error.error?.description || error.message
      );

      res.status(error.statusCode || 400).json({
        success: false,
        message:
          error.error?.description ||
          error.message ||
          "Could not verify payment",
      });
    }
  }
);

app.post("/api/payments/razorpay/webhook", async (req, res) => {
  try {
    if (!razorpayWebhookSecret) {
      return res.status(503).json({
        success: false,
        message: "Razorpay webhook is not configured",
      });
    }

    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({
        success: false,
        message: "Webhook body must be raw",
      });
    }

    const receivedSignature = String(
      req.headers["x-razorpay-signature"] || ""
    );
    const expectedSignature = crypto
      .createHmac("sha256", razorpayWebhookSecret)
      .update(req.body)
      .digest("hex");

    if (!signaturesMatch(receivedSignature, expectedSignature)) {
      return res.status(400).json({
        success: false,
        message: "Invalid webhook signature",
      });
    }

    const event = JSON.parse(req.body.toString("utf8"));

    if (event.event !== "payment.captured") {
      return res.json({ success: true, ignored: true });
    }

    const paymentEntity = event.payload?.payment?.entity;

    if (!paymentEntity?.id || !paymentEntity?.order_id) {
      return res.json({ success: true, ignored: true });
    }

    const paymentSessionRecord = await PaymentSession.findOne({
      razorpayOrderId: paymentEntity.order_id,
    });

    if (!paymentSessionRecord) {
      return res.json({ success: true, ignored: true });
    }

    const payment = await getCapturedRazorpayPayment({
      razorpayOrderId: paymentSessionRecord.razorpayOrderId,
      razorpayPaymentId: paymentEntity.id,
      amountInPaise: paymentSessionRecord.amountInPaise,
    });

    await finaliseRazorpayPayment({
      paymentSessionRecord,
      payment,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Razorpay webhook failed:", error.message);

    if (
      ["PAYMENT_REFUNDED", "PAYMENT_REVIEW_REQUIRED"].includes(
        error.code
      )
    ) {
      return res.json({ success: true, handled: true });
    }

    res.status(500).json({
      success: false,
      message: "Webhook processing failed",
    });
  }
});

app.post("/api/orders", optionalUser, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const { customer, items, paymentMethod, couponCode } = req.body;
    const normalizedCoupon = String(couponCode || "")
      .trim()
      .toUpperCase();

    const cleanCustomer = {
      name: String(customer?.name || "").trim(),
      phone: String(customer?.phone || "").replace(/\D/g, ""),
      address: String(customer?.address || "").trim(),
      city: String(customer?.city || "").trim(),
      pincode: String(customer?.pincode || "").replace(/\D/g, ""),
    };

    if (
      !cleanCustomer.name ||
      !cleanCustomer.address ||
      !cleanCustomer.city ||
      cleanCustomer.phone.length !== 10 ||
      cleanCustomer.pincode.length !== 6
    ) {
      throw new Error("Please enter valid delivery details");
    }

    if (!Array.isArray(items) || !items.length) {
      throw new Error("Your cart is empty");
    }

    if (paymentMethod && paymentMethod !== "cod") {
      throw new Error(
        "Online payment is not available yet. Please choose Cash on Delivery."
      );
    }

    if (normalizedCoupon && normalizedCoupon !== "WELCOME10") {
      throw new Error("Invalid coupon code");
    }

    let order;

    await session.withTransaction(async () => {
      const orderItems = [];
      let subtotal = 0;

      for (const item of items) {
        const productId = item?.productId;
        const quantity = Number(item?.quantity);

        if (
          !mongoose.Types.ObjectId.isValid(productId) ||
          !Number.isInteger(quantity) ||
          quantity < 1
        ) {
          throw new Error("Invalid product or quantity in cart");
        }

        const product = await Product.findOneAndUpdate(
          {
            _id: productId,
            stock: { $gte: quantity },
          },
          { $inc: { stock: -quantity } },
          { new: true, session }
        );

        if (!product) {
          throw new Error(
            "A product is unavailable or does not have enough stock"
          );
        }

        const lineTotal = product.price * quantity;
        subtotal += lineTotal;

        orderItems.push({
          product: product._id,
          brand: product.brand,
          title: product.title,
          image: product.image,
          price: product.price,
          quantity,
          subtotal: lineTotal,
        });
      }

      const normalizedCity = cleanCustomer.city
        .toLowerCase()
        .replace(/\s+/g, " ");
      const isKanpurAddress = normalizedCity.includes("kanpur");
      const deliveryFee =
        subtotal >= 499 ? 0 : isKanpurAddress ? 29 : 49;
      let discountAmount = 0;

      if (normalizedCoupon === "WELCOME10") {
        if (subtotal <= 499) {
          throw new Error(
            "WELCOME10 applies only when the cart subtotal is above â‚¹499"
          );
        }

        discountAmount = Math.round(subtotal * 0.1);
      }

      [order] = await Order.create(
        [
          {
            orderNumber: createOrderNumber(),
            user: req.user?.userId || null,
            customer: cleanCustomer,
            items: orderItems,
            deliveryFee,
            couponCode: normalizedCoupon,
            discountAmount,
            totalAmount: subtotal - discountAmount + deliveryFee,
            deliveryType: isKanpurAddress ? "local" : "courier",
            paymentMethod: "cod",
          },
        ],
        { session }
      );

      if (req.user?.userId) {
        await User.findByIdAndUpdate(
          req.user.userId,
          { $set: cleanCustomer },
          { session, runValidators: true }
        );
      }
    });

    res.status(201).json({
      success: true,
      message: "Your order has been placed successfully",
      order,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Could not place your order",
    });
  } finally {
    await session.endSession();
  }
});

app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });

    res.json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch {
    res.status(500).json({
      success: false,
      message: "Could not load orders",
    });
  }
});

app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const { orderStatus } = req.body;

    if (!orderStatuses.includes(orderStatus)) {
      return res.status(400).json({
        success: false,
        message: "Please choose a valid order status",
      });
    }

    if (orderStatus === "cancelled") {
      return res.status(400).json({
        success: false,
        message: "Use the cancel order action instead",
      });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { orderStatus },
      { new: true, runValidators: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    res.json({
      success: true,
      message: "Order status updated successfully",
      order,
    });
  } catch {
    res.status(400).json({
      success: false,
      message: "Could not update order status",
    });
  }
});

app.post("/api/orders/:id/cancel", requireAdmin, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    let order;

    await session.withTransaction(async () => {
      order = await Order.findOne({ _id: req.params.id }).session(session);

      if (!order) {
        throw new Error("Order not found");
      }

      if (order.orderStatus === "cancelled") {
        throw new Error("This order has already been cancelled");
      }

      if (["shipped", "delivered"].includes(order.orderStatus)) {
        throw new Error(
          "A shipped or delivered order cannot be cancelled from admin"
        );
      }

      for (const item of order.items) {
        await Product.findByIdAndUpdate(
          item.product,
          { $inc: { stock: item.quantity } },
          { session }
        );
      }

      order.orderStatus = "cancelled";
      order.stockRestored = true;
      order.cancelledAt = new Date();

      await order.save({ session });
    });

    res.json({
      success: true,
      message: "Order cancelled and stock restored",
      order,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message || "Could not cancel order",
    });
  } finally {
    await session.endSession();
  }
});

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected");

    app.listen(PORT, () => {
      console.log(`DEALROOT backend running on ${PORT}`);
    });
  } catch (error) {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  }
};

startServer();