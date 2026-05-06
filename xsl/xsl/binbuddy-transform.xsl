<?xml version="1.0" encoding="UTF-8"?>
<!--
  BinBuddy - XSLT Stylesheet
  Transforms binbuddy-data.xml into HTML report
  Powerpuff w/ Mojo Jojo - Technopreneurship Final Project
  Usage: Open xml-viewer.html which loads this via JavaScript XSLT processor
-->
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">

  <xsl:output method="html" encoding="UTF-8" indent="yes"/>

  <!-- ===== ROOT TEMPLATE ===== -->
  <xsl:template match="/">
    <html lang="en">
      <head>
        <meta charset="UTF-8"/>
        <title>BinBuddy – Data Report</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; background: #f5faf5; color: #1a2e1a; margin: 0; padding: 20px; }
          .report-header { background: linear-gradient(135deg, #006400, #228B22); color: white; padding: 24px; border-radius: 16px; margin-bottom: 24px; }
          .report-header h1 { margin: 0; font-size: 1.8rem; }
          .report-header p { margin: 6px 0 0; opacity: 0.85; font-size: 0.9rem; }
          .section { background: white; border-radius: 12px; padding: 20px; margin-bottom: 20px; border: 1px solid #d4e8d4; box-shadow: 0 2px 10px rgba(0,100,0,0.08); }
          .section h2 { color: #006400; font-size: 1.2rem; border-bottom: 2px solid #90EE90; padding-bottom: 10px; margin-bottom: 16px; }
          table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
          th { background: #eaf7ea; color: #006400; padding: 10px 12px; text-align: left; font-weight: 700; }
          td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; }
          tr:hover td { background: #f5faf5; }
          .badge { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: 0.75rem; font-weight: 700; }
          .badge-bio { background: #e8f8e8; color: #1a5c1a; }
          .badge-rec { background: #e8f0f8; color: #1a3a6c; }
          .badge-res { background: #fef3e2; color: #7a4a00; }
          .badge-spc { background: #fde8e8; color: #7a1a1a; }
          .badge-household { background: #e8f8e8; color: #1a5c1a; }
          .badge-collector { background: #e8ecf8; color: #1a3a6c; }
          .badge-admin { background: #fde8e8; color: #7a1a1a; }
          .pts { font-weight: 800; color: #006400; }
          .verified { color: #228B22; font-weight: 700; }
          .unverified { color: #e74c3c; font-weight: 700; }
          .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
          .stat-box { background: linear-gradient(135deg, #006400, #228B22); color: white; border-radius: 10px; padding: 16px; text-align: center; }
          .stat-box .sv { font-size: 1.6rem; font-weight: 900; }
          .stat-box .sl { font-size: 0.75rem; opacity: 0.85; margin-top: 4px; }
          footer { text-align: center; color: #888; font-size: 0.78rem; margin-top: 24px; padding-top: 12px; border-top: 1px solid #d4e8d4; }
        </style>
      </head>
      <body>
        <!-- Header -->
        <div class="report-header">
          <h1>♻️ BinBuddy Data Report</h1>
          <p>Smart Waste Tracking Platform – Quezon City, Philippines | Generated via XSLT</p>
        </div>

        <!-- Summary Stats -->
        <div class="stat-grid">
          <div class="stat-box">
            <div class="sv"><xsl:value-of select="count(//user)"/></div>
            <div class="sl">Total Users</div>
          </div>
          <div class="stat-box">
            <div class="sv"><xsl:value-of select="count(//log)"/></div>
            <div class="sl">Waste Logs</div>
          </div>
          <div class="stat-box">
            <div class="sv"><xsl:value-of select="count(//reward)"/></div>
            <div class="sl">Rewards Available</div>
          </div>
        </div>

        <!-- Users Section -->
        <div class="section">
          <h2>👥 Registered Users</h2>
          <table>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Role</th>
              <th>Barangay</th>
              <th>EcoPoints</th>
              <th>Streak</th>
            </tr>
            <xsl:apply-templates select="//user"/>
          </table>
        </div>

        <!-- Waste Logs Section -->
        <div class="section">
          <h2>📦 Waste Disposal Logs</h2>
          <table>
            <tr>
              <th>Log ID</th>
              <th>User</th>
              <th>Type</th>
              <th>Category</th>
              <th>Quantity</th>
              <th>Date</th>
              <th>Method</th>
              <th>Verified</th>
              <th>Points</th>
            </tr>
            <xsl:apply-templates select="//log"/>
          </table>
        </div>

        <!-- Rewards Section -->
        <div class="section">
          <h2>⭐ Rewards Catalog</h2>
          <table>
            <tr>
              <th>Reward</th>
              <th>Name</th>
              <th>Points Required</th>
              <th>Category</th>
              <th>Sponsor</th>
              <th>Available</th>
            </tr>
            <xsl:apply-templates select="//reward"/>
          </table>
        </div>

        <!-- Barangay Stats Section -->
        <div class="section">
          <h2>🏘️ Barangay Statistics</h2>
          <table>
            <tr>
              <th>Barangay</th>
              <th>Households</th>
              <th>Active Users</th>
              <th>Waste (tons)</th>
              <th>Segregation %</th>
              <th>Recycling %</th>
              <th>EcoPoints Given</th>
              <th>Plan</th>
            </tr>
            <xsl:apply-templates select="//barangay"/>
          </table>
        </div>

        <footer>
          BinBuddy – Powerpuff w/ Mojo Jojo | Technopreneurship Final Project | RA 9003 Aligned | SDG 12
        </footer>
      </body>
    </html>
  </xsl:template>

  <!-- ===== USER TEMPLATE ===== -->
  <xsl:template match="user">
    <tr>
      <td><xsl:value-of select="@id"/></td>
      <td><strong><xsl:value-of select="n"/></strong></td>
      <td>
        <span>
          <xsl:attribute name="class">badge badge-<xsl:value-of select="@role"/></xsl:attribute>
          <xsl:value-of select="@role"/>
        </span>
      </td>
      <td><xsl:value-of select="barangay"/>, <xsl:value-of select="city"/></td>
      <td class="pts">
        <xsl:if test="ecoPoints">
          ⭐ <xsl:value-of select="ecoPoints"/>
        </xsl:if>
        <xsl:if test="not(ecoPoints)">—</xsl:if>
      </td>
      <td>
        <xsl:if test="streak">🔥 <xsl:value-of select="streak"/> days</xsl:if>
        <xsl:if test="not(streak)">—</xsl:if>
      </td>
    </tr>
  </xsl:template>

  <!-- ===== LOG TEMPLATE ===== -->
  <xsl:template match="log">
    <tr>
      <td><xsl:value-of select="@id"/></td>
      <td><xsl:value-of select="@userId"/></td>
      <td>
        <span>
          <xsl:attribute name="class">
            badge badge-<xsl:choose>
              <xsl:when test="type='biodegradable'">bio</xsl:when>
              <xsl:when test="type='recyclable'">rec</xsl:when>
              <xsl:when test="type='residual'">res</xsl:when>
              <xsl:otherwise>spc</xsl:otherwise>
            </xsl:choose>
          </xsl:attribute>
          <xsl:choose>
            <xsl:when test="type='biodegradable'">🌿 Biodegradable</xsl:when>
            <xsl:when test="type='recyclable'">♻️ Recyclable</xsl:when>
            <xsl:when test="type='residual'">🗑️ Residual</xsl:when>
            <xsl:otherwise>⚠️ Special</xsl:otherwise>
          </xsl:choose>
        </span>
      </td>
      <td><xsl:value-of select="category"/></td>
      <td><xsl:value-of select="quantity"/> <xsl:value-of select="quantity/@unit"/></td>
      <td><xsl:value-of select="date"/></td>
      <td>
        <xsl:choose>
          <xsl:when test="method='qr_scan'">📱 QR Scan</xsl:when>
          <xsl:otherwise>✏️ Manual</xsl:otherwise>
        </xsl:choose>
      </td>
      <td>
        <xsl:choose>
          <xsl:when test="verified='true'"><span class="verified">✅ Yes</span></xsl:when>
          <xsl:otherwise><span class="unverified">❌ No</span></xsl:otherwise>
        </xsl:choose>
      </td>
      <td class="pts">+<xsl:value-of select="ecoPointsEarned"/></td>
    </tr>
  </xsl:template>

  <!-- ===== REWARD TEMPLATE ===== -->
  <xsl:template match="reward">
    <tr>
      <td><xsl:value-of select="icon"/></td>
      <td><strong><xsl:value-of select="n"/></strong></td>
      <td class="pts">⭐ <xsl:value-of select="pointsCost"/></td>
      <td><xsl:value-of select="category"/></td>
      <td><xsl:value-of select="sponsor"/></td>
      <td>
        <xsl:choose>
          <xsl:when test="available='true'"><span class="verified">Available</span></xsl:when>
          <xsl:otherwise><span class="unverified">Unavailable</span></xsl:otherwise>
        </xsl:choose>
      </td>
    </tr>
  </xsl:template>

  <!-- ===== BARANGAY TEMPLATE ===== -->
  <xsl:template match="barangay">
    <tr>
      <td><strong><xsl:value-of select="n"/></strong>, <xsl:value-of select="city"/></td>
      <td><xsl:value-of select="totalHouseholds"/></td>
      <td><xsl:value-of select="activeUsers"/></td>
      <td><xsl:value-of select="totalWasteCollected"/></td>
      <td><xsl:value-of select="segregationRate"/>%</td>
      <td><xsl:value-of select="recyclingRate"/>%</td>
      <td class="pts"><xsl:value-of select="ecoPointsDistributed"/></td>
      <td>
        <xsl:choose>
          <xsl:when test="subscriptionPlan='premium'">
            <span class="badge" style="background:#fff8e1;color:#7a4a00;">⭐ Premium</span>
          </xsl:when>
          <xsl:otherwise>
            <span class="badge badge-rec">Basic</span>
          </xsl:otherwise>
        </xsl:choose>
      </td>
    </tr>
  </xsl:template>

</xsl:stylesheet>
